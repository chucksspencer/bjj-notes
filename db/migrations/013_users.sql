-- Several people, each with their own notebook. The starter positions stay shared; techniques, notes,
-- sessions, sources, the focus list, the undo log, photos and every sign-in belong to one person.
-- Everything that existed before belongs to the owner (the first user), so nobody is signed out.

create table if not exists users (
  id            serial primary key,
  email         text,
  name          text,
  -- Null for the owner, whose password is OWNER_PASSWORD (managed with the other deploy secrets).
  password_hash text,
  is_owner      boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email)) where email is not null;
create unique index if not exists users_one_owner on users (is_owner) where is_owner;

insert into users (is_owner, name) values (true, 'Chuck');

-- One-time links the owner makes: to join (create an account) or to reset someone's password.
-- Only a SHA-256 of the token is stored.
create table if not exists invites (
  id          serial primary key,
  token_hash  text not null unique,
  purpose     text not null check (purpose in ('join', 'reset')),
  created_by  int not null references users (id) on delete cascade,
  -- For a reset: whose password it sets.
  user_id     int references users (id) on delete cascade,
  -- Who a join link is for (prefills their details; they can change them).
  name        text,
  email       text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     int references users (id) on delete set null
);

-- Bearer tokens for each person's Siri Shortcuts. (API_TOKEN keeps working as the owner's.)
create table if not exists api_tokens (
  id           serial primary key,
  user_id      int not null references users (id) on delete cascade,
  token_hash   text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists api_tokens_user on api_tokens (user_id);

-- Every row gets an owner; what's there now is the owner's.
do $$
declare
  t text;
  owner_id int := (select id from users where is_owner);
begin
  foreach t in array array['techniques', 'sessions', 'sources', 'notes', 'focus_items', 'activity_log',
                           'web_sessions', 'oauth_codes', 'oauth_tokens', 'attachments',
                           'note_techniques', 'technique_links', 'focus_item_techniques'] loop
    execute format('alter table %I add column user_id int references users (id) on delete cascade', t);
    execute format('update %I set user_id = $1', t) using owner_id;
    execute format('alter table %I alter column user_id set not null', t);
  end loop;
end $$;

-- Rows that point at two of a person's things must point at the same person's: a note can't be filed
-- under someone else's technique, whatever id a request sends. The database enforces it.
alter table techniques  add constraint techniques_id_user  unique (id, user_id);
alter table notes       add constraint notes_id_user       unique (id, user_id);
alter table sessions    add constraint sessions_id_user    unique (id, user_id);
alter table sources     add constraint sources_id_user     unique (id, user_id);
alter table focus_items add constraint focus_items_id_user unique (id, user_id);

alter table note_techniques
  drop constraint if exists note_techniques_note_id_fkey,
  drop constraint if exists note_techniques_technique_id_fkey,
  add foreign key (note_id, user_id) references notes (id, user_id) on delete cascade,
  add foreign key (technique_id, user_id) references techniques (id, user_id) on delete cascade;

alter table technique_links
  drop constraint if exists technique_links_from_id_fkey,
  drop constraint if exists technique_links_to_id_fkey,
  add foreign key (from_id, user_id) references techniques (id, user_id) on delete cascade,
  add foreign key (to_id, user_id) references techniques (id, user_id) on delete cascade;

alter table focus_item_techniques
  drop constraint if exists focus_item_techniques_focus_item_id_fkey,
  drop constraint if exists focus_item_techniques_technique_id_fkey,
  add foreign key (focus_item_id, user_id) references focus_items (id, user_id) on delete cascade,
  add foreign key (technique_id, user_id) references techniques (id, user_id) on delete cascade;

alter table notes
  drop constraint if exists notes_session_id_fkey,
  drop constraint if exists notes_source_id_fkey,
  add foreign key (session_id, user_id) references sessions (id, user_id) on delete set null (session_id),
  add foreign key (source_id, user_id) references sources (id, user_id) on delete set null (source_id);

alter table attachments
  drop constraint if exists attachments_note_id_fkey,
  add foreign key (note_id, user_id) references notes (id, user_id) on delete set null (note_id);

-- Names, links and phone-made ids are unique per person, not across everyone.
drop index if exists techniques_name_key;
create unique index techniques_name_key on techniques (user_id, lower(name));

alter table sources drop constraint if exists sources_url_key;
create unique index sources_user_url on sources (user_id, url);

drop index if exists notes_client_id;
create unique index notes_client_id on notes (user_id, client_id) where client_id is not null;

create index if not exists techniques_user on techniques (user_id);
create index if not exists notes_user on notes (user_id, observed_on desc);
create index if not exists sessions_user on sessions (user_id, date desc);
create index if not exists focus_items_user on focus_items (user_id);
create index if not exists activity_log_user on activity_log (user_id, id desc);
create index if not exists attachments_user on attachments (user_id);
create index if not exists web_sessions_user on web_sessions (user_id);
create index if not exists oauth_tokens_user on oauth_tokens (user_id);
