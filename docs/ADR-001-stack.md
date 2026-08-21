# ADR-001: Backend stack

Status: accepted. Closes the decision list in #14.

## Language and framework

**TypeScript, Node 20+, ESM.** The SDK (`@credivis/elixir-sdk`) is TypeScript and is the
single source of truth for `Intent`, auth-entry assembly, and client-side simulation. The
backend must consume the same code the frontend uses so the two never disagree about what a
proposal encodes to. Rust would share contract types but would mean a second implementation
of the auth-entry logic — the exact duplication docs/GAPS.md warns against.

Until the SDK is published as a versioned package, `packages/core/src/intent.ts` mirrors the
SDK `Intent` type verbatim. Swap to the import when the package exists.

- HTTP: **Fastify** (api service). Schema-validated routes, fast, well-typed.
- Validation: **zod** for env and request bodies.
- Logging: **pino**, with secret-field redaction on by default.

## Service boundaries

```
packages/core       config, db, logger, shared types        (library)
services/api        proposals, partial signatures, reads    (#2)
services/relayer    channel pool, fee strategy, submission  (#3)
services/indexer    event ingest, backfill, reconciliation  (#5)
```

Workers (TTL top-up #6, notifications #7) land as `services/workers` when built. Each
service is a separate process with its own env and its own blast radius: the relayer is the
only process that ever holds signing keys.

## Database

**Postgres 16** via the `postgres` driver, with plain SQL migrations in
`packages/core/migrations`. No ORM. Reasons: the indexer is append-heavy and needs explicit
indexes and `insert ... on conflict` semantics; the proposal service needs row locks for
nonce conflicts; both are clearer in SQL than through a query builder.

Migrations are forward-only, one transaction each, recorded in `schema_migrations`.

## Local dev

`docker compose up` gives Postgres and a Stellar quickstart node with Soroban RPC on
`:8000`. `.env.example` documents every variable; `loadConfig()` validates them at boot.

## CI

GitHub Actions on push to `main` and every PR: `format:check`, `lint`, `typecheck`,
`migrate` (against a Postgres service container), `test`, `build`. DB-backed tests skip
locally when `DATABASE_URL` is unset and run in CI.

## Secrets

See `docs/SECURITY.md`. Short version: nothing secret is ever in the repo; env in dev, a
secret manager in production; relayer keys live only in the relayer process.
