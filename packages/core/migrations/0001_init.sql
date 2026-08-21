create extension if not exists pgcrypto;

-- Managed Elixir accounts. config_epoch mirrors on-chain; the indexer keeps it current.
create table accounts (
  address       text primary key,
  network       text not null check (network in ('testnet', 'public')),
  config_epoch  bigint not null default 0,
  threshold     int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Signers known for an account, with the Squads-style role bitmask
-- (Initiate=1, Vote=2, Execute=4).
create table account_signers (
  account   text not null references accounts(address) on delete cascade,
  signer    text not null,
  roles     int not null default 7,
  primary key (account, signer)
);
