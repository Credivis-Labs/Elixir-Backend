import type { Sql } from "@elixir/core";

export interface TimelineEntry {
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  kind: string;
  data: unknown;
}

export interface ProposalHistory {
  proposalId: string;
  events: TimelineEntry[];
  status: string;
}

export async function timeline(
  sql: Sql,
  account: string,
  opts: { limit?: number; beforeLedger?: number } = {},
): Promise<TimelineEntry[]> {
  const limit = Math.min(opts.limit ?? 100, 1000);
  const rows = await sql<
    { ledger: string | number; ledgerClosedAt: Date; txHash: string; kind: string; data: unknown }[]
  >`
    select ledger, ledger_closed_at, tx_hash, kind, data
    from indexed_events
    where contract = ${account}
      ${opts.beforeLedger !== undefined ? sql`and ledger < ${opts.beforeLedger}` : sql``}
    order by ledger desc, event_index desc
    limit ${limit}`;
  return rows.map((r) => ({ ...r, ledger: Number(r.ledger) }));
}

/**
 * Queue-path proposal history, grouped by on-chain proposal id from the event
 * data. Status is derived from the last lifecycle event seen.
 */
export async function proposalHistory(sql: Sql, account: string): Promise<ProposalHistory[]> {
  const rows = await sql<
    {
      ledger: string | number;
      ledgerClosedAt: Date;
      txHash: string;
      kind: string;
      data: unknown;
      proposalId: string | null;
    }[]
  >`
    select ledger, ledger_closed_at, tx_hash, kind, data,
           coalesce(data->>'proposal_id', data->>'id') as proposal_id
    from indexed_events
    where contract = ${account}
      and kind in ('propose', 'approve', 'reject', 'cancel', 'execute')
    order by ledger, event_index`;
  const byId = new Map<string, ProposalHistory>();
  for (const r of rows) {
    if (!r.proposalId) continue;
    const h = byId.get(r.proposalId) ?? { proposalId: r.proposalId, events: [], status: "open" };
    h.events.push({
      ledger: Number(r.ledger),
      ledgerClosedAt: r.ledgerClosedAt,
      txHash: r.txHash,
      kind: r.kind,
      data: r.data,
    });
    h.status = statusAfter(r.kind, h.status);
    byId.set(r.proposalId, h);
  }
  return [...byId.values()];
}

function statusAfter(kind: string, prev: string): string {
  switch (kind) {
    case "propose":
      return "open";
    case "execute":
      return "executed";
    case "cancel":
      return "cancelled";
    case "reject":
      return "rejected";
    default:
      return prev;
  }
}

export async function openGaps(sql: Sql, network: string) {
  return sql`
    select from_ledger, to_ledger, reason, detected_at
    from ledger_gaps where network = ${network} and resolved_at is null
    order by from_ledger`;
}

export async function openAlerts(sql: Sql) {
  return sql`
    select account, field, indexed, onchain, detected_at
    from reconciliation_alerts where resolved_at is null
    order by detected_at desc`;
}
