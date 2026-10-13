-- Browser sign-ins for the web app. Only a SHA-256 of the cookie value is stored.
create table web_sessions (
  token_hash   text primary key,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  user_agent   text
);
