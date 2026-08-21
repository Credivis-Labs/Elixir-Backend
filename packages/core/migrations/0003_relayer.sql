-- One row per submission attempt. Feeds relayer metrics (latency, failure
-- rate, fee spend per account) and, later, the published commitment log (#4).
create table submissions (
  id               uuid primary key default gen_random_uuid(),
  account          text not null,
  proposal_id      uuid,
  channel          text not null,
  attempt          int not null,
  fee_stroops      bigint not null,
  auth_hash        text not null,
  tx_hash          text,
  status           text not null check (status in ('pending', 'success', 'failed', 'expired')),
  error            text,
  submitted_at     timestamptz not null default now(),
  completed_at     timestamptz,
  latency_ms       int
);

create index submissions_account on submissions (account, submitted_at desc);

-- Records use of the member G-account fallback path. A spike here means the
-- relayer is down or censoring; alert on it (#4).
create table fallback_submissions (
  id           uuid primary key default gen_random_uuid(),
  account      text not null,
  proposal_id  uuid,
  submitter    text not null,
  tx_hash      text,
  created_at   timestamptz not null default now()
);
