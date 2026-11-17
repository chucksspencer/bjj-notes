-- The owner becomes an ordinary account. At startup the server copies OWNER_PASSWORD into the owner's
-- password_hash (if it has none yet) and API_TOKEN into the owner's Siri tokens (once); from then on the
-- deploy secrets are ignored. See importOwnerSecrets in src/auth/users.ts.

-- One-off flags the server keeps for itself, such as 'imported_owner_api_token'.
create table if not exists app_state (
  key   text primary key,
  value text,
  at    timestamptz default now()
);

-- Wrong passwords, per account (the lower-cased email as typed, or '(owner)' for the owner before they
-- have an email). Too many in a short time and sign-in for that account waits. Pruned by housekeeping.
create table if not exists sign_in_failures (
  id      serial primary key,
  account text not null,
  at      timestamptz not null default now()
);
create index if not exists sign_in_failures_account_at on sign_in_failures (account, at);
