-- Focus items become areas: a part of the game with a title, a description, techniques and notes,
-- and now, optionally, a plan (where it starts, and a tree of "if they do this, I do that").
-- Being on the focus list is just a state of an area: ranked when it's on, no rank when it's off.
-- Paused, backlog, done and removed all become "off focus"; the history of those changes is kept.

alter table focus_items rename to areas;
alter table areas rename column label to name;
alter table areas rename constraint focus_items_id_user to areas_id_user;
alter index focus_items_user rename to areas_user;

alter table areas
  add column if not exists aliases           text[] not null default '{}',
  -- Where its plan starts in the position graph. The finer situation ("they have the underhook and
  -- crossface") is the premise, in words: it isn't worth a position of its own.
  add column if not exists start_position_id int references positions (id),
  add column if not exists start_role        text check (start_role in ('top', 'bottom', 'neutral')),
  add column if not exists premise           text;
create index if not exists areas_start on areas (start_position_id);

-- On focus = has a rank. Everything else is off (and keeps its place in the notebook).
update areas set rank = null where status <> 'active';
-- An active item with no rank goes to the end of its owner's list.
update areas a set rank = m.top + n.pos
from (select id, row_number() over (partition by user_id order by id) as pos from areas where status = 'active' and rank is null) n,
     (select user_id, coalesce(max(rank), 0) as top from areas group by user_id) m
where a.id = n.id and m.user_id = a.user_id;
-- Close the gaps left by the items that came off: each list runs 1, 2, 3...
update areas a set rank = r.pos
from (select id, row_number() over (partition by user_id order by rank, id) as pos from areas where rank is not null) r
where a.id = r.id;
alter table areas drop column status;

alter table focus_item_techniques rename to area_techniques;
alter table area_techniques rename column focus_item_id to area_id;
alter table focus_item_notes rename to area_notes;
alter table area_notes rename column focus_item_id to area_id;
alter index focus_item_notes_note rename to area_notes_note;
alter index focus_item_notes_user rename to area_notes_user;

-- The focus history stays, under one more kind of event: taken off the list.
alter table focus_events rename column focus_item_id to area_id;
alter table focus_events drop constraint if exists focus_events_event_check;
alter table focus_events add constraint focus_events_event_check
  check (event in ('added', 'moved', 'removed', 'paused', 'resumed', 'completed', 'backlogged', 'dropped'));

-- One step of an area's plan. Top-level steps (no parent) are the main line, in order; a step's
-- children are what follows it, each usually with a trigger ("if they post the far leg").
create table if not exists area_steps (
  id             serial primary key,
  area_id        int not null,
  user_id        int not null references users (id) on delete cascade,
  parent_id      int,
  -- Order among steps with the same parent (1 = first).
  ordinal        int not null default 1,
  -- The reaction or condition that leads here, in words. Null for "next, do this".
  trigger        text,
  -- What to do, as it was said ("octopus sweeps", "go to deep half"). Always kept, so a step still
  -- reads right when it names a family of moves, or its technique card is later deleted.
  action         text not null,
  -- The technique card it is, when it is one.
  technique_id   int,
  -- Where the step leaves you, when that matters (a hand-off to whatever starts there).
  to_position_id int references positions (id),
  to_role        text check (to_role in ('top', 'bottom', 'neutral')),
  -- Why: the intent or cue ("force them to post the underhook hand").
  note           text,
  constraint area_steps_id_area unique (id, area_id),
  foreign key (area_id, user_id) references areas (id, user_id) on delete cascade,
  -- A step's parent is a step of the same area.
  foreign key (parent_id, area_id) references area_steps (id, area_id) on delete cascade,
  foreign key (technique_id, user_id) references techniques (id, user_id) on delete set null (technique_id)
);
create index if not exists area_steps_area on area_steps (area_id, parent_id, ordinal);
create index if not exists area_steps_technique on area_steps (technique_id);
create index if not exists area_steps_to on area_steps (to_position_id);
create index if not exists area_steps_user on area_steps (user_id);
