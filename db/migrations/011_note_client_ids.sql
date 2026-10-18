-- Notes saved from the phone carry an id the phone made up, so a save retried after a dropped
-- connection (or synced from the offline queue twice) is recognised instead of saved again.
alter table notes add column if not exists client_id text;
create unique index if not exists notes_client_id on notes (client_id) where client_id is not null;
