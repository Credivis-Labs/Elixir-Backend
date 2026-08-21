-- Every contract event we have ever seen, forever. Soroban RPC keeps events for
-- days; this table is the audit trail. See docs/indexer.md for retention.
create table indexed_events (
  id               bigserial primary key,
  ledger           bigint not null,
  ledger_closed_at timestamptz not null,
  tx_hash          text not null,
  event_index      int not null,
  contract         text not null,
  kind             text not null,
  topics           jsonb not null,
  data             jsonb not null,
  ingested_at      timestamptz not null default now(),
  unique (ledger, tx_hash, event_index)
);

create index indexed_events_contract_ledger on indexed_events (contract, ledger, event_index);
create index indexed_events_kind on indexed_events (kind);

-- Single-row cursor per network. last_ledger is the highest ledger fully ingested.
create table indexer_cursor (
  network      text primary key,
  last_ledger  bigint not null,
  updated_at   timestamptz not null default now()
);

-- Ledger ranges we know we did not ingest (RPC retention passed, outage, etc).
-- Unresolved gaps mean the audit trail is incomplete and must be backfilled from
-- an archive source.
create table ledger_gaps (
  id           bigserial primary key,
  network      text not null,
  from_ledger  bigint not null,
  to_ledger    bigint not null,
  reason       text not null,
  detected_at  timestamptz not null default now(),
  resolved_at  timestamptz
);

-- Indexed state disagreed with on-chain state. Each row is an alert.
create table reconciliation_alerts (
  id           bigserial primary key,
  account      text not null,
  field        text not null,
  indexed      text,
  onchain      text,
  detected_at  timestamptz not null default now(),
  resolved_at  timestamptz
);
