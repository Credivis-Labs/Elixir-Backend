# Security and secrets

The relayer holds channel account keys and a fee-source key. Those keys can spend XLM and,
if leaked, let an attacker impersonate our submission path. This policy applies from commit
one.

## Rules

1. **No secrets in git.** `.env` and `.env.*` are ignored; only `.env.example` is committed
   and it holds placeholders. CI fails if a secret-shaped string (`S[A-Z2-7]{55}`) appears in
   a tracked file — see `scripts/check-secrets.sh`.
2. **Env in development, secret manager in production.** Production reads
   `RELAYER_CHANNEL_SECRETS` and `RELAYER_FEE_SOURCE_SECRET` from the platform secret store
   (AWS Secrets Manager / GCP Secret Manager / Vault) injected as env at process start.
   Nothing writes them to disk.
3. **Only the relayer process loads signing keys.** `api` and `indexer` do not declare them
   in their config schema, so they cannot read them even if present in the environment.
4. **Logs redact.** `createLogger` redacts `secret`, `secrets`, `seed`, `privateKey` fields.
   Never log a keypair object.
5. **Rotate on any exposure.** Channel accounts are cheap; treat them as disposable. A
   rotation is: fund new accounts, swap the env, drain and merge the old ones.
6. **Least privilege for the DB.** Each service gets its own role. The indexer role cannot
   write `proposals`; the api role cannot write `indexed_events`.

## What the backend is not trusted for

A signer must be able to verify what they are signing without trusting this service. The
API stores and relays; it never decides _what_ is signed. Clients simulate locally and
compare the signature payload hash against their own wallet display. If the backend is
fully compromised the worst it can do is withhold or delay — never forge.
