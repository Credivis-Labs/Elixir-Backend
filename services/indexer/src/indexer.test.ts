import { createLogger } from "@elixir/core";
import { testDb } from "@elixir/core/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, reconfigureData } from "./decode.js";
import { Indexer } from "./indexer.js";
import { openAlerts, openGaps, proposalHistory, timeline } from "./queries.js";
import {
  toJson,
  type ChainReader,
  type EventPage,
  type EventSource,
  type RawEvent,
} from "./source.js";

const sql = await testDb();
const ACCOUNT = "CINDEXERTESTACCOUNT000000000000000000000000000000000000000";

const ev = (partial: Partial<RawEvent> & { ledger: number; topics: unknown[] }): RawEvent => ({
  ledgerClosedAt: new Date(1_700_000_000_000 + partial.ledger * 5000).toISOString(),
  txHash: `tx${partial.ledger}`,
  eventIndex: 0,
  contract: ACCOUNT,
  data: {},
  ...partial,
});

function scriptedSource(pages: EventPage[]): EventSource & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async getEvents(start) {
      calls.push(start);
      return pages.shift() ?? { events: [], latestLedger: start, oldestLedger: 1 };
    },
  };
}

const chain = (epoch: bigint): ChainReader => ({
  async getAccountConfig() {
    return { configEpoch: epoch, frozenUntil: 0n };
  },
});

describe("decode", () => {
  it("classifies contractevent struct names", () => {
    expect(classify(ev({ ledger: 1, topics: ["Reconfigured"] }))).toBe("reconfigure");
    expect(classify(ev({ ledger: 1, topics: ["Frozen"] }))).toBe("freeze");
    expect(classify(ev({ ledger: 1, topics: ["Executed"] }))).toBe("execute");
    expect(classify(ev({ ledger: 1, topics: ["Something"] }))).toBe("unknown");
    expect(classify(ev({ ledger: 1, topics: [] }))).toBe("unknown");
  });

  it("extracts reconfigure fields", () => {
    const d = reconfigureData(
      ev({
        ledger: 1,
        topics: ["Reconfigured"],
        data: { rule_id: 1, signer_count: 3, threshold: 2, config_epoch: "4" },
      }),
    );
    expect(d).toEqual({ configEpoch: 4n, threshold: 2, signerCount: 3 });
  });

  it("makes native values JSON-safe", () => {
    expect(toJson({ a: 1n, b: Buffer.from([255]), c: [2n] })).toEqual({
      a: "1",
      b: "ff",
      c: ["2"],
    });
  });
});

describe.skipIf(!sql)("Indexer", () => {
  const log = createLogger("test", "silent");
  const mk = (source: EventSource, reader: ChainReader = chain(0n)) =>
    new Indexer(sql!, source, reader, log, { network: "testnet", genesisLedger: 10 });

  beforeAll(async () => {
    await sql!`delete from indexed_events where contract = ${ACCOUNT}`;
    await sql!`delete from ledger_gaps where network = 'testnet'`;
    await sql!`delete from reconciliation_alerts where account = ${ACCOUNT}`;
    await sql!`delete from indexer_cursor where network = 'testnet'`;
    await sql!`delete from accounts where address = ${ACCOUNT}`;
    await sql!`insert into accounts (address, network, config_epoch, threshold)
               values (${ACCOUNT}, 'testnet', 0, 1)`;
  });

  afterAll(async () => sql!.end());

  it("starts at genesis when there is no cursor and advances it", async () => {
    const source = scriptedSource([
      {
        events: [
          ev({ ledger: 12, topics: ["Frozen"], data: { frozen_until: "999" } }),
          ev({ ledger: 15, topics: ["Unfrozen"], data: { at: "1000" } }),
        ],
        latestLedger: 20,
        oldestLedger: 1,
      },
    ]);
    const idx = mk(source);
    const r = await idx.runOnce();
    expect(source.calls).toEqual([10]);
    expect(r).toMatchObject({ fromLedger: 10, toLedger: 15, ingested: 2, gaps: 0 });
    expect(await idx.cursor()).toBe(15);
  });

  it("is idempotent on replay", async () => {
    const idx = mk(
      scriptedSource([
        {
          events: [ev({ ledger: 12, topics: ["Frozen"], data: { frozen_until: "999" } })],
          latestLedger: 20,
          oldestLedger: 1,
        },
      ]),
    );
    await idx.backfill(10, [ACCOUNT]);
    const rows =
      await sql!`select count(*)::int as n from indexed_events where contract = ${ACCOUNT}`;
    expect(rows[0]!.n).toBe(2);
    expect(await idx.cursor()).toBe(15);
  });

  it("records a gap when the source retention has passed the cursor", async () => {
    const idx = mk(
      scriptedSource([
        {
          events: [ev({ ledger: 40, topics: ["Frozen"], data: { frozen_until: "1" } })],
          latestLedger: 41,
          oldestLedger: 30,
        },
      ]),
    );
    const r = await idx.runOnce();
    expect(r.gaps).toBe(1);
    const gaps = await openGaps(sql!, "testnet");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ fromLedger: "16", toLedger: "29" });
    expect(await idx.cursor()).toBe(40);
  });

  it("applies Reconfigured to accounts", async () => {
    const idx = mk(
      scriptedSource([
        {
          events: [
            ev({
              ledger: 45,
              topics: ["Reconfigured"],
              data: { rule_id: 1, signer_count: 3, threshold: 2, config_epoch: "1" },
            }),
          ],
          latestLedger: 45,
          oldestLedger: 1,
        },
      ]),
    );
    const r = await idx.runOnce();
    expect(r.reconfigures).toBe(1);
    const [acct] =
      await sql!`select config_epoch, threshold from accounts where address = ${ACCOUNT}`;
    expect(acct).toMatchObject({ configEpoch: "1", threshold: 2 });
  });

  it("reconciles indexed vs on-chain config and alerts on divergence", async () => {
    expect(await mk(scriptedSource([]), chain(1n)).reconcile(ACCOUNT)).toBe(0);
    expect(await mk(scriptedSource([]), chain(2n)).reconcile(ACCOUNT)).toBe(1);
    const alerts = await openAlerts(sql!);
    expect(alerts[0]).toMatchObject({ account: ACCOUNT, indexed: "1", onchain: "2" });
  });

  it("serves the account timeline newest-first", async () => {
    const t = await timeline(sql!, ACCOUNT, { limit: 10 });
    expect(t.map((e) => e.ledger)).toEqual([45, 40, 15, 12]);
    const older = await timeline(sql!, ACCOUNT, { beforeLedger: 40 });
    expect(older.map((e) => e.ledger)).toEqual([15, 12]);
  });

  it("groups queue-path events into proposal history", async () => {
    const idx = mk(
      scriptedSource([
        {
          events: [
            ev({ ledger: 50, topics: ["Proposed"], data: { proposal_id: "7" } }),
            ev({ ledger: 51, topics: ["Approved"], data: { proposal_id: "7", by: "GA" } }),
            ev({ ledger: 52, topics: ["Executed"], data: { proposal_id: "7" } }),
            ev({ ledger: 52, eventIndex: 1, topics: ["Proposed"], data: { proposal_id: "8" } }),
          ],
          latestLedger: 52,
          oldestLedger: 1,
        },
      ]),
    );
    await idx.runOnce();
    const history = await proposalHistory(sql!, ACCOUNT);
    expect(history).toHaveLength(2);
    expect(history.find((h) => h.proposalId === "7")).toMatchObject({
      status: "executed",
      events: [{ kind: "propose" }, { kind: "approve" }, { kind: "execute" }],
    });
    expect(history.find((h) => h.proposalId === "8")?.status).toBe("open");
  });
});
