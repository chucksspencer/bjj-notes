-- Focus items become their own thing: a title (the label), a description, and links to notes as well as
-- techniques. The one-line goal is folded into the description.
alter table focus_items add column if not exists description text;

-- Goals move into the new description. The goal column is left in place, unused, because undo entries
-- written before this (restore_focus, restore_focus_label) still put goals back.
update focus_items set description = 'Goal: ' || btrim(goal) where goal is not null and btrim(goal) <> '' and description is null;

-- Notes pinned to a focus item, apart from the notes that reach it through its techniques.
create table if not exists focus_item_notes (
  focus_item_id int not null,
  note_id       int not null,
  user_id       int not null references users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (focus_item_id, note_id),
  foreign key (focus_item_id, user_id) references focus_items (id, user_id) on delete cascade,
  foreign key (note_id, user_id) references notes (id, user_id) on delete cascade
);
create index if not exists focus_item_notes_note on focus_item_notes (note_id);
create index if not exists focus_item_notes_user on focus_item_notes (user_id);
