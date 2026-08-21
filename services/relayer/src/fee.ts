import type { FeeStats } from "./rpc.js";

export interface FeeConfig {
  /** Floor in stroops. Stellar minimum is 100. */
  minFee: number;
  /** Hard ceiling in stroops per transaction. The relayer never pays more. */
  maxFee: number;
  /** Multiplier applied per retry attempt (attempt 0 = first). */
  escalation: number;
  /** p90/p50 ratio above which the network is considered surging. */
  surgeRatio: number;
}

export const defaultFeeConfig: FeeConfig = {
  minFee: 100,
  maxFee: 1_000_000,
  escalation: 1.5,
  surgeRatio: 2,
};

export type FeeDecision =
  | { ok: true; fee: number; surge: boolean }
  | { ok: false; reason: "over_cap"; wanted: number; cap: number };

/**
 * Pick the inclusion fee for an attempt.
 *
 * Normal conditions: bid p50. Surge (p90 much higher than p50): bid p90 so we
 * do not sit in the queue while auth entries tick toward expiry. Each retry
 * escalates geometrically. Above `maxFee` we refuse rather than pay anything —
 * the caller decides whether to fall back to a member G-account.
 */
export function pickFee(stats: FeeStats, attempt: number, cfg = defaultFeeConfig): FeeDecision {
  const surge = stats.p50 > 0 && stats.p90 / stats.p50 >= cfg.surgeRatio;
  const base = Math.max(cfg.minFee, surge ? stats.p90 : stats.p50);
  const wanted = Math.ceil(base * Math.pow(cfg.escalation, attempt));
  if (wanted > cfg.maxFee) return { ok: false, reason: "over_cap", wanted, cap: cfg.maxFee };
  return { ok: true, fee: wanted, surge };
}
