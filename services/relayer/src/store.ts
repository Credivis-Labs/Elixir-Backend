import type { Sql } from "@elixir/core";
import type { SubmissionRecord, SubmissionStore } from "./relayer.js";

export function sqlSubmissionStore(sql: Sql): SubmissionStore {
  return {
    async record(r: SubmissionRecord) {
      await sql`
        insert into submissions (account, proposal_id, channel, attempt, fee_stroops, auth_hash,
                                 tx_hash, status, error, completed_at, latency_ms)
        values (${r.account}, ${r.proposalId ?? null}, ${r.channel}, ${r.attempt},
                ${r.feeStroops}, ${r.authHash}, ${r.txHash}, ${r.status}, ${r.error},
                now(), ${r.latencyMs})`;
    },
  };
}

export const memorySubmissionStore = (): SubmissionStore & { records: SubmissionRecord[] } => {
  const records: SubmissionRecord[] = [];
  return {
    records,
    async record(r) {
      records.push(r);
    },
  };
};
