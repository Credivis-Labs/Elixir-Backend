import type { Logger, Sql } from "@elixir/core";
import { classify, reconfigureData } from "./decode.js";
import type { ChainReader, EventSource, RawEvent } from "./source.js";

export interface IndexerOptions {
  network: "testnet" | "public";
  /** Contracts to follow. Refreshed from `accounts` on every run. */
  extraContracts?: string[];
  pageSize?: number;
  /** If no cursor exists, start here. */
  genesisLedger?: number;
}

export interface RunReport {
  fromLedger: number;
  toLedger: number;
  ingested: number;
  gaps: number;
  reconfigures: number;
}

/**
 * Pulls contract events into Postgres and keeps derived account state current.
 *
 * Idempotent: events are keyed by (ledger, tx_hash, event_index) and upserted,
 * so replaying a range is safe. The cursor only advances after the page is
 * written. If the source can no longer serve the ledger after the cursor, the
 * missing range is recorded in `ledger_gaps` and the cursor jumps forward, so
 * live tailing continues and the hole is visible rather than silent.
 */
export class Indexer {
  constructor(
    private readonly sql: Sql,
    private readonly source: EventSource,
    private readonly chain: ChainReader,
    private readonly log: Logger,
    private readonly opts: IndexerOptions,
  ) {}

  async contracts(): Promise<string[]> {
    const rows = await this.sql<{ address: string }[]>`
      select address from accounts where network = ${this.opts.network}`;
    return [...new Set([...rows.map((r) => r.address), ...(this.opts.extraContracts ?? [])])];
  }

  async cursor(): Promise<number | null> {
    const [row] = await this.sql<{ lastLedger: string | number }[]>`
      select last_ledger from indexer_cursor where network = ${this.opts.network}`;
    return row ? Number(row.lastLedger) : null;
  }

  private async setCursor(ledger: number) {
    await this.sql`
      insert into indexer_cursor (network, last_ledger, updated_at)
      values (${this.opts.network}, ${ledger}, now())
      on conflict (network) do update set last_ledger = excluded.last_ledger, updated_at = now()`;
  }

  /** Ingest one page from the cursor. Call in a loop for live tailing. */
  async runOnce(): Promise<RunReport> {
    const contracts = await this.contracts();
    const cursor = await this.cursor();
    const start = cursor === null ? (this.opts.genesisLedger ?? 1) : cursor + 1;
    return this.ingestFrom(start, contracts);
  }

  /**
   * Re-ingest from a ledger (e.g. an account's creation ledger). Does not move
   * the live cursor backwards; writes are idempotent.
   */
  async backfill(fromLedger: number, contracts?: string[]): Promise<RunReport> {
    return this.ingestFrom(fromLedger, contracts ?? (await this.contracts()), false);
  }

  private async ingestFrom(
    start: number,
    contracts: string[],
    advanceCursor = true,
  ): Promise<RunReport> {
    const report: RunReport = {
      fromLedger: start,
      toLedger: start - 1,
      ingested: 0,
      gaps: 0,
      reconfigures: 0,
    };
    if (contracts.length === 0) return report;

    const page = await this.source.getEvents(start, contracts, this.opts.pageSize ?? 1000);

    if (page.oldestLedger > start) {
      await this.sql`
        insert into ledger_gaps (network, from_ledger, to_ledger, reason)
        values (${this.opts.network}, ${start}, ${page.oldestLedger - 1},
                'source retention: ledgers no longer available')`;
      report.gaps = 1;
      this.log.warn(
        { from: start, to: page.oldestLedger - 1 },
        "ledger gap: source no longer has these ledgers; backfill from archive",
      );
    }

    for (const e of page.events) {
      const kind = classify(e);
      await this.sql`
        insert into indexed_events (ledger, ledger_closed_at, tx_hash, event_index, contract,
                                    kind, topics, data)
        values (${e.ledger}, ${e.ledgerClosedAt}, ${e.txHash}, ${e.eventIndex}, ${e.contract},
                ${kind}, ${this.sql.json(e.topics as never)}, ${this.sql.json(e.data as never)})
        on conflict (ledger, tx_hash, event_index) do nothing`;
      report.ingested++;
      if (kind === "reconfigure" && (await this.applyReconfigure(e))) report.reconfigures++;
    }

    const last = page.events.at(-1);
    const reached = last ? last.ledger : page.latestLedger;
    report.toLedger = Math.max(reached, page.oldestLedger - 1, start - 1);
    if (advanceCursor) await this.setCursor(report.toLedger);
    return report;
  }

  /**
   * A Reconfigured event bumps config_epoch. Mirror it into `accounts` and void
   * every proposal signed under the old epoch — same rule the proposal service
   * applies, enforced here from chain truth.
   */
  private async applyReconfigure(e: RawEvent): Promise<boolean> {
    const d = reconfigureData(e);
    if (!d) return false;
    await this.sql`
      update accounts
      set config_epoch = ${d.configEpoch.toString()}, threshold = ${d.threshold}, updated_at = now()
      where address = ${e.contract} and config_epoch < ${d.configEpoch.toString()}`;
    if (!(await this.hasProposalsTable())) return true;
    await this.sql`
      update proposals
      set status = 'invalidated',
          status_reason = ${`Account configuration changed on-chain (epoch ${d.configEpoch}, ledger ${e.ledger}). Signatures collected under the previous signer set are void; re-create and re-sign.`},
          updated_at = now()
      where account = ${e.contract} and config_epoch < ${d.configEpoch.toString()}
        and status in ('open', 'ready')`;
    return true;
  }

  /** `proposals` ships with the api service (#2); this service must work without it. */
  private async hasProposalsTable(): Promise<boolean> {
    const [row] = await this.sql<{ ok: string | null }[]>`select to_regclass('proposals') as ok`;
    return row?.ok !== null && row?.ok !== undefined;
  }

  /**
   * Compare what we think an account's state is against the chain. Writes an
   * alert row per divergent field. Returns the number of new alerts.
   */
  async reconcile(account?: string): Promise<number> {
    const targets = account ? [account] : await this.contracts();
    let alerts = 0;
    for (const addr of targets) {
      const onchain = await this.chain.getAccountConfig(addr);
      if (!onchain) continue;
      const [row] = await this.sql<{ configEpoch: string | number | bigint }[]>`
        select config_epoch from accounts where address = ${addr}`;
      if (!row) continue;
      const indexed = BigInt(row.configEpoch);
      if (indexed !== onchain.configEpoch) {
        await this.sql`
          insert into reconciliation_alerts (account, field, indexed, onchain)
          values (${addr}, 'config_epoch', ${indexed.toString()}, ${onchain.configEpoch.toString()})`;
        alerts++;
        this.log.error(
          { account: addr, indexed: indexed.toString(), onchain: onchain.configEpoch.toString() },
          "reconciliation: config_epoch diverged",
        );
      }
    }
    return alerts;
  }
}
