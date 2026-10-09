-- Core schema: a position graph, techniques as edges, notes, sessions, focus.

create extension if not exists pg_trgm;
create extension if not exists fuzzystrmatch;

-- Lowercase, strip everything but letters and digits ("De La Riva" -> "delariva").
create or replace function bjj_norm(s text) returns text
language sql immutable as $$
  select regexp_replace(lower(coalesce(s, '')), '[^a-z0-9]', '', 'g')
$$;

-- Lowercase words padded with spaces, for "is this name mentioned in that text" checks.
create or replace function bjj_words(s text) returns text
language sql immutable as $$
  select ' ' || trim(regexp_replace(lower(coalesce(s, '')), '[^a-z0-9]+', ' ', 'g')) || ' '
$$;

-- Fuzzy score between a stored name and a (possibly voice-mangled) query, 0..1.
-- Combines trigram similarity, edit distance on the squashed form, and
-- word similarity so partial names ("ghost") still find "Ghost escape".
create or replace function bjj_name_score(cand text, q text) returns real
language sql stable as $$
  select greatest(
    similarity(lower(cand), lower(q)),
    similarity(bjj_norm(cand), bjj_norm(q)),
    case when greatest(length(bjj_norm(cand)), length(bjj_norm(q))) = 0 then 0
         else 1 - levenshtein(left(bjj_norm(cand), 255), left(bjj_norm(q), 255))::real
                  / greatest(length(bjj_norm(cand)), length(bjj_norm(q)))
    end,
    0.9 * word_similarity(lower(q), lower(cand))
  )::real
$$;

create table positions (
  id          serial primary key,
  slug        text not null unique,
  name        text not null,
  aliases     text[] not null default '{}',
  category    text not null check (category in ('standing', 'guard', 'pin', 'back', 'leg', 'transitional')),
  description text
);

create table techniques (
  id          serial primary key,
  name        text not null,
  aliases     text[] not null default '{}',
  type        text not null check (type in ('submission', 'sweep', 'pass', 'escape', 'transition', 'takedown',
                                            'retention', 'control', 'entry', 'counter', 'concept')),
  role        text check (role in ('top', 'bottom', 'neutral')),
  gi          text not null default 'both' check (gi in ('gi', 'nogi', 'both')),
  status      text not null default 'seen' check (status in ('seen', 'learning', 'drilling', 'hitting', 'reliable')),
  summary     text,
  key_details text[] not null default '{}',
  mistakes    text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index techniques_name_key on techniques (lower(name));

-- A technique moves you from one place in the position graph to another.
-- Most techniques have one edge; some apply from several positions.
-- A submission has no destination; a control/grip may have no destination.
create table technique_edges (
  id               serial primary key,
  technique_id     int not null references techniques (id) on delete cascade,
  from_position_id int references positions (id),
  from_role        text check (from_role in ('top', 'bottom', 'neutral')),
  to_position_id   int references positions (id),
  to_role          text check (to_role in ('top', 'bottom', 'neutral')),
  unique nulls not distinct (technique_id, from_position_id, from_role, to_position_id, to_role)
);
create index technique_edges_from on technique_edges (from_position_id);
create index technique_edges_to on technique_edges (to_position_id);

-- Technique-to-technique relationships.
create table technique_links (
  from_id int not null references techniques (id) on delete cascade,
  to_id   int not null references techniques (id) on delete cascade,
  kind    text not null check (kind in ('chain', 'counter', 'variation', 'setup', 'related')),
  note    text,
  primary key (from_id, to_id, kind)
);

create table sessions (
  id          serial primary key,
  date        date not null,
  kind        text not null default 'class' check (kind in ('class', 'open_mat', 'private', 'seminar', 'competition', 'drilling', 'other')),
  gi          text check (gi in ('gi', 'nogi', 'both')),
  instructor  text,
  location    text,
  summary     text,
  created_at  timestamptz not null default now()
);
create index sessions_date on sessions (date);

create table sources (
  id         serial primary key,
  kind       text not null check (kind in ('class', 'youtube', 'instagram', 'instructional', 'book', 'article', 'other')),
  url        text unique,
  title      text,
  author     text,
  created_at timestamptz not null default now()
);

create table notes (
  id               serial primary key,
  body             text not null,
  raw_text         text,
  kind             text not null default 'instruction' check (kind in ('instruction', 'rolling', 'drilling', 'question', 'idea')),
  observed_on      date not null default current_date,
  session_id       int references sessions (id) on delete set null,
  source_id        int references sources (id) on delete set null,
  source_timestamp text,
  inbox            boolean not null default false,
  created_via      text not null default 'mcp' check (created_via in ('mcp', 'capture', 'web')),
  created_at       timestamptz not null default now(),
  search           tsvector generated always as (to_tsvector('english', body)) stored
);
create index notes_search on notes using gin (search);
create index notes_observed_on on notes (observed_on);
create index notes_inbox on notes (inbox) where inbox;

create table note_techniques (
  note_id      int not null references notes (id) on delete cascade,
  technique_id int not null references techniques (id) on delete cascade,
  primary key (note_id, technique_id)
);
create index note_techniques_technique on note_techniques (technique_id);

-- The rolling focus list. Active items are ordered by rank (1 = top).
create table focus_items (
  id         serial primary key,
  label      text not null,
  goal       text,
  status     text not null default 'active' check (status in ('active', 'backlog', 'paused', 'done', 'dropped')),
  rank       int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table focus_item_techniques (
  focus_item_id int not null references focus_items (id) on delete cascade,
  technique_id  int not null references techniques (id) on delete cascade,
  primary key (focus_item_id, technique_id)
);

-- Every change to the focus list, so focus over time can be replayed.
create table focus_events (
  id            serial primary key,
  focus_item_id int not null references focus_items (id) on delete cascade,
  event         text not null check (event in ('added', 'moved', 'paused', 'resumed', 'completed', 'backlogged', 'dropped')),
  from_status   text,
  to_status     text,
  from_rank     int,
  to_rank       int,
  at            timestamptz not null default now()
);
create index focus_events_item on focus_events (focus_item_id, at);

-- Write log used by undo_last.
create table activity_log (
  id      serial primary key,
  action  text not null,
  summary text not null,
  undo    jsonb not null,
  undone  boolean not null default false,
  at      timestamptz not null default now()
);

-- OAuth 2.1 (single user). Codes and tokens are stored as SHA-256 hashes.
create table oauth_clients (
  client_id  text primary key,
  info       jsonb not null,
  created_at timestamptz not null default now()
);

create table oauth_codes (
  code_hash      text primary key,
  client_id      text not null references oauth_clients (client_id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  scopes         text[] not null default '{}',
  resource       text,
  expires_at     timestamptz not null,
  used           boolean not null default false
);

create table oauth_tokens (
  token_hash text primary key,
  kind       text not null check (kind in ('access', 'refresh')),
  client_id  text not null references oauth_clients (client_id) on delete cascade,
  scopes     text[] not null default '{}',
  resource   text,
  expires_at timestamptz not null,
  revoked    boolean not null default false,
  created_at timestamptz not null default now()
);
