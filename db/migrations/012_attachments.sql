-- Photos and videos on notes. The originals stay in the owner's Apple Photos library: the app keeps a
-- reference to find them there, plus a small still image so the web app on a desktop, and Claude, can
-- see what each one is.
create table if not exists attachments (
  id serial primary key,
  -- Set null (not cascade) when a note is deleted, so undoing the delete can link its clips again.
  note_id integer references notes(id) on delete set null,
  kind text not null check (kind in ('photo', 'video')),
  -- PHAsset local identifier (this phone) and cloud identifier (any device on the same iCloud Photos).
  photos_local_id text,
  photos_cloud_id text,
  filename text,
  taken_at timestamptz,
  duration_s real,
  width integer,
  height integer,
  thumb bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_note on attachments (note_id);
