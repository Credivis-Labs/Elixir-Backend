import type { RawEvent } from "./source.js";

export type EventKind =
  | "reconfigure"
  | "freeze"
  | "unfreeze"
  | "propose"
  | "approve"
  | "reject"
  | "cancel"
  | "execute"
  | "unknown";

/**
 * `#[contractevent]` emits the struct name as the first topic (e.g. `Reconfigured`)
 * and the fields as the data map. Map those names onto the stable kinds the dapp
 * and the proposal service consume. Unknown names are kept, not dropped — the
 * audit trail must be complete even for events we did not anticipate.
 */
const KINDS: Record<string, EventKind> = {
  Reconfigured: "reconfigure",
  Frozen: "freeze",
  Unfrozen: "unfreeze",
  Proposed: "propose",
  Approved: "approve",
  Rejected: "reject",
  Cancelled: "cancel",
  Executed: "execute",
};

export function classify(e: RawEvent): EventKind {
  const name = e.topics[0];
  if (typeof name !== "string") return "unknown";
  return KINDS[name] ?? "unknown";
}

export interface ReconfigureData {
  configEpoch: bigint;
  threshold: number;
  signerCount: number;
}

export function reconfigureData(e: RawEvent): ReconfigureData | null {
  const d = e.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;
  const epoch = d.config_epoch ?? d.configEpoch;
  const threshold = d.threshold;
  const signerCount = d.signer_count ?? d.signerCount;
  if (epoch === undefined || threshold === undefined) return null;
  return {
    configEpoch: BigInt(String(epoch)),
    threshold: Number(threshold),
    signerCount: Number(signerCount ?? 0),
  };
}
