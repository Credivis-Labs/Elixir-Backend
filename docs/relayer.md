# Relayer

`services/relayer` submits signed Soroban invocations on behalf of Elixir accounts. A
contract account cannot be a transaction source, so something must be; this is that thing,
and it is an honest centralization point. This document says what it does, what it cannot
do, and how to live without it.

## What it can and cannot do

- **Can:** delay, reorder, or refuse to submit. Spend its own XLM on fees.
- **Cannot:** forge, alter, or replay a signed invocation. Auth entries commit to the
  invocation, a nonce, an expiry ledger, and the network passphrase. The relayer hashes the
  auth entries on intake and re-checks the hash after transaction assembly on every attempt
  (`payload_mutated` aborts if they differ). A fee bump never touches the signed bytes.

## Submission flow

1. Decode `hostFunctionXdr` and `authEntriesXdr`; compute `authHash`.
2. If the earliest `signatureExpirationLedger` is within `expiryMarginLedgers` (default 2) of
   the current ledger, refuse with `auth_expired` and both ledger numbers. Nothing is sent.
3. Pick a fee from `getFeeStats`: p50 normally, p90 during a surge (p90/p50 ≥ 2), escalated
   ×1.5 per retry, never above `RELAYER_MAX_FEE`. Over the cap → `fee_cap_exceeded`.
4. Lease a channel account, build the transaction with the channel as source, simulate,
   assert `authHash` unchanged, sign with the channel key, send.
5. `txBadSeq` → drop the cached sequence, refetch, retry. `txInsufficientFee` or
   `TRY_AGAIN_LATER` → retry at the next fee tier. Anything else → `tx_failed`.
6. Poll until `SUCCESS`/`FAILED` or `confirmTimeoutMs`.

Every attempt is written to `submissions` with fee, latency, channel, and outcome.

## Channel accounts

`RELAYER_CHANNEL_SECRETS` is a comma-separated list of S-secrets for funded G-accounts.
The pool leases one channel per in-flight transaction and tracks sequence numbers locally, so
concurrent submissions never collide. The pool is process-local; run one relayer per channel
set, or move the lease into Postgres (`select ... for update skip locked`) before running
replicas against shared channels.

Channels are disposable. Rotation: fund new ones, swap the env, drain and merge the old.

## Fallback: member G-account submission

`POST /fallback` returns an **unsigned** transaction whose source is the member's own
G-account, carrying the same host function and the same signed auth entries. The member
signs it with their wallet and submits it themselves via any Horizon/RPC. The relayer does
not need to be up for this to work — the dapp can build the same transaction client-side
from the SDK; the endpoint exists for convenience and to record that fallback was used.

Fallback use is recorded in `fallback_submissions` and counted in `relayer_fallback_total`.
A spike means the relayer is down, slow, or censoring. Alert on it (#4).

## Metrics

`GET /metrics` (Prometheus text):

- `relayer_submissions_total{outcome=success|failed|expired|fee_cap}`
- `relayer_fee_spend_stroops_total{account=...}` — feeds unit economics (#12)
- `relayer_fee_escalations_total`, `relayer_surge_attempts_total`, `relayer_fallback_total`
- `relayer_submission_latency_ms{quantile=0.5|0.95}`

## Ordering policy

FIFO by arrival at `POST /submit`, one channel per transaction, no fee-priority reordering.
Publishing a tamper-evident log of arrivals so this can be audited is #4.

## OpenZeppelin Relayer evaluation

Evaluated `openzeppelin/openzeppelin-relayer` (Rust, supports Stellar) before building this.

| Need                                              | OZ Relayer                                                 | Verdict                                       |
| ------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| Channel pool + sequence management                | Yes, per-relayer signer; multiple relayers for parallelism | Comparable                                    |
| Fee policy with cap                               | Yes (policies, `max_fee`)                                  | Comparable                                    |
| Refuse on auth-entry expiry with explicit reason  | No — it would submit and get a Soroban auth failure        | Missing; this is a top support case for us    |
| Assert auth entries unchanged across resubmission | Not a concept there                                        | Missing; core safety invariant for a multisig |
| Per-Elixir-account fee attribution                | Would need a plugin                                        | Missing                                       |
| Member-fallback transaction construction          | No                                                         | Missing                                       |
| Published ordering commitments (#4)               | No                                                         | Missing                                       |

Conclusion: OZ Relayer is a good generic fee payer but the Elixir-specific pieces (expiry
preflight, payload-immutability assertion, fallback, commitment log) are the parts that
matter for a custody product and would have to live in a wrapper anyway. The wrapper is
roughly this service. Revisit if OZ adds Soroban auth-entry awareness; the `RpcClient`
boundary makes swapping the submission backend cheap.
