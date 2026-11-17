-- What growing from one person to several, and from focus items to areas to game plans, left behind.
-- Drops columns (game_plans.goal, focus_events.from_status and to_status): their contents can't come back
-- without a backup.

-- Goals were folded into the description in 015. Undo entries from before still carry a goal; it's ignored.
alter table game_plans drop column if exists goal;

-- ---------- focus history ----------

-- The statuses from before focus items became game plans, as what they mean now: back on, or off.
update focus_events set event = 'added' where event = 'resumed';
update focus_events set event = 'removed' where event in ('paused', 'completed', 'backlogged', 'dropped');
alter table focus_events drop constraint if exists focus_events_event_check;
alter table focus_events add constraint focus_events_event_check check (event in ('added', 'moved', 'removed'));
alter table focus_events drop column if exists from_status;
alter table focus_events drop column if exists to_status;

-- Whose it is, like every other notebook table, and it can only point at that person's game plan.
alter table focus_events add column if not exists user_id int;
update focus_events e set user_id = a.user_id from game_plans a where a.id = e.game_plan_id and e.user_id is null;
alter table focus_events alter column user_id set not null;
alter table focus_events drop constraint if exists focus_events_game_plan_id_fkey;
alter table focus_events add constraint focus_events_game_plan_id_user_id_fkey
  foreign key (game_plan_id, user_id) references game_plans (id, user_id) on delete cascade;
alter table focus_events add constraint focus_events_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
-- focus_events_item was (game_plan_id, at), named for focus items; history is read by game plan or by person, in id order.
drop index if exists focus_events_item;
create index if not exists focus_events_game_plan on focus_events (game_plan_id, user_id);
create index if not exists focus_events_user on focus_events (user_id, id);

-- ---------- position edges ----------

alter table technique_edges add column if not exists user_id int;
update technique_edges e set user_id = t.user_id from techniques t where t.id = e.technique_id and e.user_id is null;
alter table technique_edges alter column user_id set not null;
alter table technique_edges drop constraint if exists technique_edges_technique_id_fkey;
alter table technique_edges add constraint technique_edges_technique_id_user_id_fkey
  foreign key (technique_id, user_id) references techniques (id, user_id) on delete cascade;
alter table technique_edges add constraint technique_edges_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
create index if not exists technique_edges_user on technique_edges (user_id);

-- ---------- indexes from when there was one notebook ----------

-- Every query on these filters by person first; notes_user (user_id, observed_on desc) and sessions_user
-- (user_id, date desc) cover the plain date ones.
drop index if exists notes_inbox;
drop index if exists notes_observed_on;
drop index if exists notes_open_questions;
drop index if exists notes_starred;
drop index if exists notes_to_try;
drop index if exists sessions_date;
drop index if exists sessions_date_kind;
drop index if exists techniques_starred;
create index if not exists notes_user_inbox on notes (user_id) where inbox;
create index if not exists notes_user_to_try on notes (user_id) where to_try;
create index if not exists notes_user_starred on notes (user_id, starred_at desc) where starred_at is not null;
create index if not exists notes_user_open_questions on notes (user_id, observed_on desc) where kind = 'question' and answered_at is null;
create index if not exists techniques_user_starred on techniques (user_id, starred_at desc) where starred_at is not null;

-- ---------- one game plan per place on the focus list ----------

-- Each person's list runs 1, 2, 3... (ties, if any, keep the older game plan first).
update game_plans a set rank = r.pos
from (select id, row_number() over (partition by user_id order by rank, id)::int as pos from game_plans where rank is not null) r
where a.id = r.id and a.rank is distinct from r.pos;
-- Checked when the transaction commits: the list is renumbered a row at a time, so it briefly has two of a rank.
alter table game_plans add constraint game_plans_user_rank unique (user_id, rank) deferrable initially deferred;
