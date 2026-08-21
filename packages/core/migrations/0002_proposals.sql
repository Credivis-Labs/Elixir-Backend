-- Proposals are stored as chain-agnostic Intent (jsonb). payload / signature_payload
-- are derived encodings kept for convenience; a client must be able to re-derive
-- them from intent and refuse to sign if they differ.
create table proposals (
  id                 uuid primary key default gen_random_uuid(),
  account            text not null references accounts(address),
  proposer           text not null,
  intent             jsonb not null,
  payload            text not null,
  signature_payload  text not null,
  nonce              bigint not null,
  config_epoch       bigint not null,
  threshold          int not null,
  expires_at_ledger  bigint not null,
  status             text not null default 'open'
                     check (status in ('open', 'ready', 'submitted', 'executed', 'expired', 'invalidated', 'conflicted')),
  status_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Two open proposals may never share a nonce on one account: whichever executes
-- first burns the nonce and the other can never land.
create unique index proposals_open_nonce
  on proposals (account, nonce)
  where status in ('open', 'ready', 'submitted');

create index proposals_account_status on proposals (account, status);

create table partial_signatures (
  proposal_id  uuid not null references proposals(id) on delete cascade,
  signer       text not null,
  signature    text not null,
  created_at   timestamptz not null default now(),
  primary key (proposal_id, signer)
);
