# Elixir-Backend

Backend services for Elixir: `api`, `relayer`, `indexer`. See
[docs/ADR-001-stack.md](docs/ADR-001-stack.md) for the stack and
[docs/SECURITY.md](docs/SECURITY.md) for the secrets policy.

## Layout

```
packages/core       config, db + migrations, logger, shared types
services/api        proposals and partial-signature coordination
services/relayer    channel account pool and submission
services/indexer    event ingest and audit trail
```

## Local dev

```sh
cp .env.example .env
docker compose up -d          # postgres :5432, stellar quickstart :8000
pnpm install
pnpm migrate
pnpm dev:api                  # or dev:relayer / dev:indexer
```

## Checks

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

DB-backed tests run when `DATABASE_URL` is set and skip otherwise.
