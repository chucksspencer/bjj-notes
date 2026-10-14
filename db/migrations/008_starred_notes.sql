-- Starred notes: the recent, pertinent ones to keep in front of you (shown in Lab, newest star first).
alter table notes add column if not exists starred_at timestamptz;
create index if not exists notes_starred on notes (starred_at desc) where starred_at is not null;
