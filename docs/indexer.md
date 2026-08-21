# Indexer

`services/indexer` is the audit trail. Soroban RPC retains events for days; treasury
records must outlive the company. Everything below exists to make "query RPC" never be the
answer to "what happened to this account".

## Sources

`EventSource` is the boundary. Two implementations are planned; one ships now:

| Source                                                   | Purpose                                   | Retention    | Status                     |
| -------------------------------------------------------- | ----------------------------------------- | ------------ | -------------------------- |
| Soroban RPC `getEvents`                                  | bootstrap + live tail                     | ~7 days      | shipped (`rpcEventSource`) |
| Galexie / Hubble (BigQuery or self-hosted ledger export) | backfill from account genesis, gap repair | full history | next; same interface       |

The indexer does not care which it is talking to. Wiring Galexie is implementing
`getEvents(startLedger, contracts)` against its export and pointing `main.ts` at it.

## What is indexed

Every event emitted by every managed contract (`accounts` table + `INDEXER_EXTRA_CONTRACTS`),
keyed by `(ledger, tx_hash, event_index)`. `#[contractevent]` puts the struct name in
`topics[0]`; `classify()` maps it:

| Contract event                                                  | kind                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Reconfigured`                                                  | `reconfigure` — also updates `accounts.config_epoch`/`threshold` and invalidates open proposals |
| `Frozen` / `Unfrozen`                                           | `freeze` / `unfreeze`                                                                           |
| `Proposed` / `Approved` / `Rejected` / `Cancelled` / `Executed` | queue-path lifecycle (elixir_queue, once it emits)                                              |
| anything else                                                   | `unknown` — stored anyway; the trail must be complete                                           |

## Cursor, backfill, gaps

- `indexer_cursor.last_ledger` is the highest ledger fully ingested for the network.
  `runOnce()` reads from `cursor + 1`; the cursor advances only after the page is written.
- `backfill(fromLedger, contracts)` re-ingests from any ledger without moving the live
  cursor. Writes are idempotent, so replaying is always safe. `POST /accounts/:a/backfill?from=N`.
- If the source's `oldestLedger` is past the cursor (RPC retention passed during an outage),
  the missing range is written to `ledger_gaps` and the cursor jumps forward. Live tailing
  continues; the hole is visible at `GET /gaps` and must be repaired from an archive source.
  An unresolved gap means the audit trail is incomplete — treat as an incident.

## Reconciliation

`reconcile()` reads the contract instance storage on-chain (`Config.config_epoch`) and
compares it to `accounts.config_epoch`. Divergence writes a `reconciliation_alerts` row and
logs at error level. Runs every `INDEXER_RECONCILE_EVERY` ticks (default 60 × 5s) and on
demand via `POST /accounts/:a/reconcile`. `GET /alerts` lists open alerts.

## Read API

- `GET /accounts/:a/timeline?limit=&before=` — newest-first event stream for the dapp
- `GET /accounts/:a/proposals` — queue-path proposal history grouped by proposal id with
  derived status
- `GET /gaps`, `GET /alerts`, `GET /health`

## Retention policy

- `indexed_events`: **never deleted.** Append-only in normal operation. If storage cost ever
  matters, partition by ledger range and move cold partitions to cheaper storage; do not
  drop them.
- Back up Postgres daily with point-in-time recovery; keep at least one copy of the
  `indexed_events` export in object storage outside the primary cloud account, so the trail
  survives the company's infrastructure being turned off.
- `ledger_gaps` and `reconciliation_alerts`: kept forever too — they are the record of what
  the trail does _not_ contain.
- `indexer_cursor`: operational, no retention concern.

Treasury customers may need to export their own copy. `GET /accounts/:a/timeline` paginates
to genesis for that purpose; a bulk CSV/Parquet export is #8 (accounting export).
