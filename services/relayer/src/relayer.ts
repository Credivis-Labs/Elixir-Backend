import {
  Account,
  Operation,
  TransactionBuilder,
  xdr,
  type Keypair,
  type Transaction,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import type { ChannelPool } from "./channel-pool.js";
import { defaultFeeConfig, pickFee, type FeeConfig } from "./fee.js";
import { Metrics } from "./metrics.js";
import type { RpcClient } from "./rpc.js";

export interface SubmitRequest {
  /** Elixir account the invocation is for (for metrics and audit). */
  account: string;
  proposalId?: string;
  /** Base64 XDR `HostFunction` — the invocation itself. */
  hostFunctionXdr: string;
  /** Base64 XDR `SorobanAuthorizationEntry[]`, already signed by the account's signers. */
  authEntriesXdr: string[];
}

export interface SubmitResult {
  txHash: string;
  channel: string;
  attempts: number;
  feeStroops: number;
  authHash: string;
}

export interface SubmissionRecord {
  account: string;
  proposalId: string | undefined;
  channel: string;
  attempt: number;
  feeStroops: number;
  authHash: string;
  txHash: string | null;
  status: "success" | "failed" | "expired";
  error: string | null;
  latencyMs: number;
}

export interface SubmissionStore {
  record(r: SubmissionRecord): Promise<void>;
}

export class RelayerError extends Error {
  constructor(
    public readonly code:
      "auth_expired" | "fee_cap_exceeded" | "payload_mutated" | "tx_failed" | "timeout",
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface RelayerOptions {
  networkPassphrase: string;
  fee?: FeeConfig;
  maxAttempts?: number;
  /** Ledgers of headroom required between now and the earliest auth expiry. */
  expiryMarginLedgers?: number;
  /** Max ms to wait for a PENDING tx to settle. */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  timeboundsSeconds?: number;
}

/**
 * Submits signed Soroban invocations from a pooled channel account.
 *
 * Invariants:
 *  - The signed auth entries are never altered. Every attempt re-derives
 *    `authHash` from the operation's auth after assembly and aborts if it moved.
 *  - Expired auth entries are rejected before any network call, with the ledger
 *    numbers attached, so the caller can tell signers to re-sign.
 *  - Fee is bounded by `fee.maxFee`. Above that the relayer refuses and the
 *    caller can hand the invocation to a member's own G-account.
 */
export class Relayer {
  readonly metrics = new Metrics();
  private readonly fee: FeeConfig;
  private readonly maxAttempts: number;
  private readonly expiryMargin: number;
  private readonly confirmTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly timebounds: number;

  constructor(
    private readonly rpc: RpcClient,
    private readonly pool: ChannelPool,
    private readonly store: SubmissionStore,
    private readonly opts: RelayerOptions,
  ) {
    this.fee = opts.fee ?? defaultFeeConfig;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.expiryMargin = opts.expiryMarginLedgers ?? 2;
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.timebounds = opts.timeboundsSeconds ?? 60;
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const func = xdr.HostFunction.fromXdr(req.hostFunctionXdr, "base64");
    const auth = req.authEntriesXdr.map((a) => xdr.SorobanAuthorizationEntry.fromXdr(a, "base64"));
    const authHash = hashAuth(auth);

    const latest = await this.rpc.getLatestLedger();
    const earliest = earliestExpiry(auth);
    if (earliest !== null && earliest <= latest + this.expiryMargin) {
      this.metrics.inc("relayer_submissions_total", { outcome: "expired" });
      await this.store.record({
        account: req.account,
        proposalId: req.proposalId,
        channel: "-",
        attempt: 0,
        feeStroops: 0,
        authHash,
        txHash: null,
        status: "expired",
        error: "auth_expired",
        latencyMs: 0,
      });
      throw new RelayerError(
        "auth_expired",
        `Auth entries expire at ledger ${earliest}; current ledger is ${latest}. ` +
          "Signatures are no longer valid — every signer must re-sign.",
        { expiresAtLedger: earliest, currentLedger: latest },
      );
    }

    let lastError = "";
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const stats = await this.rpc.getFeeStats();
      const decision = pickFee(stats, attempt, this.fee);
      if (!decision.ok) {
        this.metrics.inc("relayer_submissions_total", { outcome: "fee_cap" });
        throw new RelayerError(
          "fee_cap_exceeded",
          `Network fee ${decision.wanted} stroops exceeds relayer cap ${decision.cap}. ` +
            "Submit via a member G-account or wait for fees to drop.",
          { wanted: decision.wanted, cap: decision.cap, attempt },
        );
      }
      if (decision.surge) this.metrics.inc("relayer_surge_attempts_total");

      const lease = await this.pool.acquire();
      const started = Date.now();
      let outcome: "ok" | "bad_seq" | "failed" = "failed";
      try {
        const tx = await this.build(lease.keypair, lease.sequence, decision.fee, func, auth);
        const assembledAuth = authOf(tx);
        if (hashAuth(assembledAuth) !== authHash) {
          throw new RelayerError("payload_mutated", "Auth entries changed during assembly", {
            before: authHash,
            after: hashAuth(assembledAuth),
          });
        }
        tx.sign(lease.keypair);

        const sent = await this.rpc.send(tx);
        if (sent.status === "ERROR") {
          const code = decodeTxError(sent.errorResult);
          lastError = code;
          if (code === "txBadSeq") {
            outcome = "bad_seq";
            continue;
          }
          if (code === "txInsufficientFee") {
            this.metrics.inc("relayer_fee_escalations_total");
            continue;
          }
          await this.finish(
            req,
            lease.keypair,
            attempt,
            decision.fee,
            authHash,
            null,
            "failed",
            code,
            started,
          );
          throw new RelayerError("tx_failed", `Transaction rejected: ${code}`, { code });
        }
        if (sent.status === "TRY_AGAIN_LATER") {
          lastError = "TRY_AGAIN_LATER";
          continue;
        }

        const result = await this.confirm(sent.hash);
        if (result === "timeout") {
          lastError = "timeout";
          outcome = "ok";
          await this.finish(
            req,
            lease.keypair,
            attempt,
            decision.fee,
            authHash,
            sent.hash,
            "failed",
            "timeout",
            started,
          );
          throw new RelayerError("timeout", "Transaction did not settle in time", {
            txHash: sent.hash,
          });
        }
        outcome = "ok";
        if (result === "FAILED") {
          await this.finish(
            req,
            lease.keypair,
            attempt,
            decision.fee,
            authHash,
            sent.hash,
            "failed",
            "FAILED",
            started,
          );
          throw new RelayerError("tx_failed", "Transaction failed on-chain", {
            txHash: sent.hash,
          });
        }
        await this.finish(
          req,
          lease.keypair,
          attempt,
          decision.fee,
          authHash,
          sent.hash,
          "success",
          null,
          started,
        );
        return {
          txHash: sent.hash,
          channel: lease.keypair.publicKey(),
          attempts: attempt + 1,
          feeStroops: decision.fee,
          authHash,
        };
      } finally {
        lease.release(outcome);
      }
    }
    this.metrics.inc("relayer_submissions_total", { outcome: "failed" });
    throw new RelayerError(
      "tx_failed",
      `Gave up after ${this.maxAttempts} attempts: ${lastError}`,
      {
        lastError,
      },
    );
  }

  private async build(
    source: Keypair,
    sequence: bigint,
    fee: number,
    func: xdr.HostFunction,
    auth: xdr.SorobanAuthorizationEntry[],
  ): Promise<Transaction> {
    // TransactionBuilder increments the sequence it is given.
    const account = new Account(source.publicKey(), (sequence - 1n).toString());
    const tx = new TransactionBuilder(account, {
      fee: String(fee),
      networkPassphrase: this.opts.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func, auth }))
      .setTimeout(this.timebounds)
      .build();
    return this.rpc.prepare(tx);
  }

  private async confirm(hash: string): Promise<"SUCCESS" | "FAILED" | "timeout"> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      const r = await this.rpc.getTransaction(hash);
      if (r.status === "SUCCESS" || r.status === "FAILED") return r.status;
      await sleep(this.pollIntervalMs);
    }
    return "timeout";
  }

  private async finish(
    req: SubmitRequest,
    channel: Keypair,
    attempt: number,
    fee: number,
    authHash: string,
    txHash: string | null,
    status: "success" | "failed",
    error: string | null,
    started: number,
  ) {
    const latencyMs = Date.now() - started;
    this.metrics.inc("relayer_submissions_total", { outcome: status });
    this.metrics.inc("relayer_fee_spend_stroops_total", { account: req.account }, fee);
    this.metrics.observeLatency(latencyMs);
    await this.store.record({
      account: req.account,
      proposalId: req.proposalId,
      channel: channel.publicKey(),
      attempt,
      feeStroops: fee,
      authHash,
      txHash,
      status,
      error,
      latencyMs,
    });
  }
}

/**
 * Member fallback: an unsigned transaction whose source is the member's own
 * G-account, carrying the same host function and the same signed auth entries.
 * The member signs the envelope with their wallet and submits it themselves.
 * Elixir keeps working when the relayer does not.
 */
export function buildFallbackTransaction(
  memberAccount: string,
  memberSequence: bigint,
  req: Pick<SubmitRequest, "hostFunctionXdr" | "authEntriesXdr">,
  fee: number,
  networkPassphrase: string,
  timeboundsSeconds = 300,
): { txXdr: string; authHash: string } {
  const func = xdr.HostFunction.fromXdr(req.hostFunctionXdr, "base64");
  const auth = req.authEntriesXdr.map((a) => xdr.SorobanAuthorizationEntry.fromXdr(a, "base64"));
  const tx = new TransactionBuilder(new Account(memberAccount, memberSequence.toString()), {
    fee: String(fee),
    networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(timeboundsSeconds)
    .build();
  return { txXdr: tx.toXdr(), authHash: hashAuth(auth) };
}

export function hashAuth(entries: xdr.SorobanAuthorizationEntry[]): string {
  const h = createHash("sha256");
  for (const e of entries) h.update(e.toXdr());
  return h.digest("hex");
}

/** Lowest signatureExpirationLedger across address-credential entries, or null. */
export function earliestExpiry(entries: xdr.SorobanAuthorizationEntry[]): number | null {
  let min: number | null = null;
  for (const e of entries) {
    const creds = e.credentials;
    if (creds.type !== "sorobanCredentialsAddress") continue;
    const exp = creds.address.signatureExpirationLedger;
    if (min === null || exp < min) min = exp;
  }
  return min;
}

function authOf(tx: Transaction): xdr.SorobanAuthorizationEntry[] {
  const op = tx.operations[0];
  if (!op || op.type !== "invokeHostFunction") return [];
  return op.auth ?? [];
}

function decodeTxError(errorResultXdr: string | undefined): string {
  if (!errorResultXdr) return "unknown";
  try {
    return xdr.TransactionResult.fromXdr(errorResultXdr, "base64").result.type;
  } catch {
    return "undecodable";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
