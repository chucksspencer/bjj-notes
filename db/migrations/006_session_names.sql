-- Where a note came from. Sessions (a class, a seminar, an open mat) get an optional event name,
-- so a note can read "Zen camp seminar by Josh Jones on 2024-02-03".
alter table sessions add column if not exists name text;
create index if not exists sessions_date_kind on sessions (date desc, kind);
