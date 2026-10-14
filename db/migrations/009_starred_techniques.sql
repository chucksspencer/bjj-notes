-- Starred techniques: like starred notes, a short-term "keep this in front of me" mark shown in the Lab.
alter table techniques add column if not exists starred_at timestamptz;
create index if not exists techniques_starred on techniques (starred_at desc) where starred_at is not null;
