-- Search by meaning. Each note and technique card gets an embedding (a list of numbers describing what the
-- text is about) from an embeddings service; texts about the same thing get nearby embeddings even when they
-- share no words. Rows are filled in and refreshed by the app when the text changes (content_hash), or when
-- the model changes. A null embedding means there was nothing worth embedding (a note that's only a link).
-- Each row belongs to the same person as its note or card, enforced like every other cross-reference.
create extension if not exists vector;

create table if not exists note_embeddings (
  note_id      int primary key,
  user_id      int not null,
  model        text not null,
  content_hash text not null,
  embedding    vector,
  updated_at   timestamptz not null default now(),
  foreign key (note_id, user_id) references notes (id, user_id) on delete cascade
);
create index if not exists note_embeddings_user on note_embeddings (user_id, model);

create table if not exists technique_embeddings (
  technique_id int primary key,
  user_id      int not null,
  model        text not null,
  content_hash text not null,
  embedding    vector,
  updated_at   timestamptz not null default now(),
  foreign key (technique_id, user_id) references techniques (id, user_id) on delete cascade
);
create index if not exists technique_embeddings_user on technique_embeddings (user_id, model);
