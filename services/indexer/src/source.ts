import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

export interface RawEvent {
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  /** Position of the event within its transaction. */
  eventIndex: number;
  contract: string;
  /** Decoded topics (native JS values). */
  topics: unknown[];
  /** Decoded data value. */
  data: unknown;
}

export interface EventPage {
  events: RawEvent[];
  /** Latest ledger known to the source at time of query. */
  latestLedger: number;
  /** Oldest ledger the source can still serve. Anything older is gone from it. */
  oldestLedger: number;
}

/**
 * Where events come from. The RPC implementation is for bootstrapping and live
 * tailing; it retains only days. A Galexie/Hubble-backed implementation of the
 * same interface is the archive path and plugs in without touching the indexer.
 */
export interface EventSource {
  getEvents(startLedger: number, contracts: string[], limit?: number): Promise<EventPage>;
}

export interface OnChainConfig {
  configEpoch: bigint;
  frozenUntil: bigint;
}

/** Reads live contract state for reconciliation. */
export interface ChainReader {
  getAccountConfig(contract: string): Promise<OnChainConfig | null>;
}

export function rpcEventSource(url: string): EventSource {
  const server = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
  return {
    async getEvents(startLedger, contracts, limit = 1000) {
      const res = await server.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: contracts }],
        limit,
      });
      const events: RawEvent[] = res.events.map((e, i) => ({
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt,
        txHash: e.txHash,
        eventIndex: indexFromId(e.id, i),
        contract: e.contractId?.contractId() ?? "",
        topics: e.topic.map((t) => toJson(scValToNative(t))),
        data: toJson(scValToNative(e.value)),
      }));
      return {
        events,
        latestLedger: res.latestLedger,
        oldestLedger: res.oldestLedger ?? 0,
      };
    },
  };
}

export function rpcChainReader(url: string): ChainReader {
  const server = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
  return {
    async getAccountConfig(contract) {
      try {
        const entry = await server.getContractData(
          contract,
          xdr.ScVal.scvLedgerKeyContractInstance(),
          rpc.Durability.Persistent,
        );
        if (entry.val.type !== "contractData") return null;
        const val = entry.val.contractData.val;
        if (val.type !== "scvContractInstance") return null;
        const storage = val.instance.storage ?? [];
        for (const item of storage) {
          const key = scValToNative(item.key);
          const isConfig = Array.isArray(key) ? key[0] === "Config" : key === "Config";
          if (!isConfig) continue;
          const cfg = scValToNative(item.val) as Record<string, unknown>;
          return {
            configEpoch: BigInt(String(cfg.config_epoch ?? 0)),
            frozenUntil: BigInt(String(cfg.frozen_until ?? 0)),
          };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

/** RPC event ids look like "<toid>-<index>"; fall back to page position. */
function indexFromId(id: string, fallback: number): number {
  const m = /-(\d+)$/.exec(id);
  return m ? Number(m[1]) : fallback;
}

/** Make native values JSON-safe (bigint → string, Buffer → hex). */
export function toJson(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  }
  return v;
}
