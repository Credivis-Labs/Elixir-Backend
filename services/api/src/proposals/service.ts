import type { Intent, Sql } from "@elixir/core";
import { verifyPartialSignature } from "./verify.js";

export const Role = { Initiate: 1, Vote: 2, Execute: 4 } as const;

export type ProposalStatus =
  "open" | "ready" | "submitted" | "executed" | "expired" | "invalidated" | "conflicted";

export interface Proposal {
  id: string;
  account: string;
  proposer: string;
  intent: Intent;
  payload: string;
  signaturePayload: string;
  nonce: bigint;
  configEpoch: bigint;
  threshold: number;
  expiresAtLedger: bigint;
  status: ProposalStatus;
  statusReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartialSignature {
  proposalId: string;
  signer: string;
  signature: string;
  createdAt: Date;
}

export interface ProposalWithProgress extends Proposal {
  signatures: PartialSignature[];
  collected: number;
}

export class ProposalError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "unknown_account"
      | "invalid_signature"
      | "stale_epoch"
      | "nonce_conflict"
      | "not_open"
      | "expired",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

interface SignerRow {
  roles: number;
}

interface AccountRow {
  configEpoch: bigint | string;
  threshold: number;
}

export interface CreateProposalInput {
  account: string;
  proposer: string;
  intent: Intent;
  payload: string;
  signaturePayload: string;
  nonce: bigint;
  expiresAtLedger: bigint;
}

/**
 * Stateful coordination for the fast path: store an Intent, collect partial
 * signatures, track threshold and expiry, and refuse anything the chain would
 * refuse (wrong epoch, burned nonce, bad signature).
 *
 * The service is a convenience layer, never an authority. Nothing here decides
 * what is signed; clients re-derive `signaturePayload` from `intent` themselves.
 */
export class ProposalService {
  constructor(private readonly sql: Sql) {}

  private async signerRoles(account: string, signer: string): Promise<number | null> {
    const [row] = await this.sql<SignerRow[]>`
      select roles from account_signers where account = ${account} and signer = ${signer}`;
    return row?.roles ?? null;
  }

  private async requireRole(account: string, signer: string, role: number): Promise<void> {
    const roles = await this.signerRoles(account, signer);
    if (roles === null) throw new ProposalError("forbidden", "Not a signer on this account", 403);
    if ((roles & role) === 0) {
      throw new ProposalError("forbidden", "Signer lacks the required role", 403);
    }
  }

  async create(input: CreateProposalInput): Promise<ProposalWithProgress> {
    const [acct] = await this.sql<AccountRow[]>`
      select config_epoch, threshold from accounts where address = ${input.account}`;
    if (!acct) throw new ProposalError("unknown_account", "Account is not managed here", 404);
    await this.requireRole(input.account, input.proposer, Role.Initiate);

    try {
      const [row] = await this.sql<Proposal[]>`
        insert into proposals (account, proposer, intent, payload, signature_payload, nonce,
                               config_epoch, threshold, expires_at_ledger)
        values (${input.account}, ${input.proposer}, ${this.sql.json(serializeIntent(input.intent) as never)},
                ${input.payload}, ${input.signaturePayload}, ${input.nonce.toString()},
                ${String(acct.configEpoch)}, ${acct.threshold}, ${input.expiresAtLedger.toString()})
        returning *`;
      return this.withProgress(row!);
    } catch (err) {
      if (isUniqueViolation(err, "proposals_open_nonce")) {
        throw new ProposalError(
          "nonce_conflict",
          `Another open proposal already uses nonce ${input.nonce}. Only one can execute; ` +
            "cancel it or pick the next nonce.",
          409,
        );
      }
      throw err;
    }
  }

  async get(id: string, reader: string): Promise<ProposalWithProgress> {
    const [row] = await this.sql<Proposal[]>`select * from proposals where id = ${id}`;
    if (!row) throw new ProposalError("not_found", "Proposal not found", 404);
    if ((await this.signerRoles(row.account, reader)) === null) {
      throw new ProposalError("forbidden", "Not a signer on this account", 403);
    }
    return this.withProgress(row);
  }

  async list(account: string, reader: string): Promise<ProposalWithProgress[]> {
    if ((await this.signerRoles(account, reader)) === null) {
      throw new ProposalError("forbidden", "Not a signer on this account", 403);
    }
    const rows = await this.sql<Proposal[]>`
      select * from proposals where account = ${account} order by created_at desc`;
    return Promise.all(rows.map((r) => this.withProgress(r)));
  }

  /**
   * Validate, then store. Validation order matters: the signature check runs
   * before any DB write so a bad signature never touches state.
   */
  async addSignature(
    id: string,
    signer: string,
    signature: string,
    currentLedger: bigint,
  ): Promise<ProposalWithProgress> {
    const [p] = await this.sql<Proposal[]>`select * from proposals where id = ${id}`;
    if (!p) throw new ProposalError("not_found", "Proposal not found", 404);
    await this.requireRole(p.account, signer, Role.Vote);

    if (p.status !== "open") {
      throw new ProposalError(
        "not_open",
        `Proposal is ${p.status}${p.statusReason ? `: ${p.statusReason}` : ""}`,
        409,
      );
    }
    if (BigInt(p.expiresAtLedger) <= currentLedger) {
      await this.setStatus(
        id,
        "expired",
        "Auth entry expiry ledger passed before threshold was met",
      );
      throw new ProposalError(
        "expired",
        "Signatures expired at the auth entry expiry ledger. Every signer must re-sign a fresh proposal.",
        409,
      );
    }
    const [acct] = await this.sql<AccountRow[]>`
      select config_epoch, threshold from accounts where address = ${p.account}`;
    if (acct && BigInt(acct.configEpoch) !== BigInt(p.configEpoch)) {
      await this.invalidateForEpoch(p.account, BigInt(acct.configEpoch));
      throw new ProposalError(
        "stale_epoch",
        "Account signers or threshold changed after this proposal was created. " +
          "All collected signatures are void; the proposal must be re-created and re-signed.",
        409,
      );
    }
    if (!verifyPartialSignature(signer, p.signaturePayload, signature)) {
      throw new ProposalError(
        "invalid_signature",
        "Signature does not verify against the proposal's signature payload",
        400,
      );
    }

    await this.sql`
      insert into partial_signatures (proposal_id, signer, signature)
      values (${id}, ${signer}, ${signature})
      on conflict (proposal_id, signer) do update set signature = excluded.signature`;

    const result = await this.withProgress(p);
    if (result.collected >= p.threshold) {
      await this.setStatus(id, "ready", null);
      result.status = "ready";
    }
    return result;
  }

  /**
   * Called by the indexer when it sees a Reconfigured event. Every open proposal
   * below the new epoch is void, and the user is told plainly why.
   */
  async invalidateForEpoch(account: string, newEpoch: bigint): Promise<number> {
    await this.sql`
      update accounts set config_epoch = ${newEpoch.toString()}, updated_at = now()
      where address = ${account} and config_epoch < ${newEpoch.toString()}`;
    const rows = await this.sql`
      update proposals
      set status = 'invalidated',
          status_reason = ${`Account configuration changed (epoch ${newEpoch}). Signatures collected under the previous signer set are void; re-create and re-sign.`},
          updated_at = now()
      where account = ${account} and config_epoch < ${newEpoch.toString()}
        and status in ('open', 'ready')
      returning id`;
    return rows.length;
  }

  /** Mark proposals whose auth entries can no longer land. */
  async expireStale(currentLedger: bigint): Promise<number> {
    const rows = await this.sql`
      update proposals
      set status = 'expired',
          status_reason = 'Auth entry expiry ledger passed before submission',
          updated_at = now()
      where expires_at_ledger <= ${currentLedger.toString()} and status in ('open', 'ready')
      returning id`;
    return rows.length;
  }

  /**
   * When one proposal executes, sibling proposals on the same nonce can never
   * land. Mark them so signers are not left waiting.
   */
  async markExecuted(id: string): Promise<void> {
    const [p] = await this.sql<Proposal[]>`
      update proposals set status = 'executed', updated_at = now()
      where id = ${id} returning account, nonce`;
    if (!p) return;
    await this.sql`
      update proposals
      set status = 'conflicted',
          status_reason = ${`Nonce ${p.nonce} was consumed by proposal ${id}`},
          updated_at = now()
      where account = ${p.account} and nonce = ${p.nonce.toString()} and id <> ${id}
        and status in ('open', 'ready', 'submitted')`;
  }

  private async setStatus(id: string, status: ProposalStatus, reason: string | null) {
    await this.sql`
      update proposals set status = ${status}, status_reason = ${reason}, updated_at = now()
      where id = ${id}`;
  }

  private async withProgress(p: Proposal): Promise<ProposalWithProgress> {
    const signatures = await this.sql<PartialSignature[]>`
      select * from partial_signatures where proposal_id = ${p.id} order by created_at`;
    return {
      ...p,
      nonce: BigInt(p.nonce),
      configEpoch: BigInt(p.configEpoch),
      expiresAtLedger: BigInt(p.expiresAtLedger),
      signatures,
      collected: signatures.length,
    };
  }
}

function serializeIntent(intent: Intent): unknown {
  return { ...intent, value: intent.value === undefined ? undefined : intent.value.toString() };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505" &&
    (err as { constraint_name?: string }).constraint_name === constraint
  );
}
