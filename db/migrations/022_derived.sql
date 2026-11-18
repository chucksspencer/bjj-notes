-- Derive, don't store: the inbox and the cards a game plan's steps use.

-- ---------- the inbox ----------

-- A note is in the inbox when it isn't on the To try list and either nothing files it (no technique, no game
-- plan) or some technique it named couldn't be placed. Only that last part is a fact of its own: it is kept as
-- `unplaced`, and the rest is worked out when the inbox is read (`inboxWhere` in src/services/views.ts).
alter table notes add column if not exists unplaced boolean not null default false;
comment on column notes.unplaced is
  'Some technique named when it was saved or filed could not be matched to a card. Keeps the note in the inbox until it is filed again.';

-- The stored flag said "in the inbox" while something filed it only in that case (and in stale rows, which
-- read the same): those are the notes with an unplaced name.
update notes n set unplaced = true
where n.inbox and not n.to_try
  and (exists (select 1 from note_techniques x where x.note_id = n.id)
       or exists (select 1 from game_plan_notes y where y.note_id = n.id));

-- No index for the derived inbox: it is read per person (notes_user), and the two "nothing files it" checks
-- use the note_techniques primary key and game_plan_notes_note. A person's notes number in the thousands.
drop index if exists notes_user_inbox;
alter table notes drop column if exists inbox;

-- ---------- a game plan's technique cards ----------

-- game_plan_techniques now holds only the links someone made. A card a step uses is on the game plan because
-- of the step, and goes when the last step using it does. Rows from before can't be told apart by how they
-- were made, so the rule is: a row whose card a step of that game plan uses is the step's, and goes; every
-- other row stays as a link someone made.
delete from game_plan_techniques gt
where exists (select 1 from game_plan_steps st
              where st.game_plan_id = gt.game_plan_id and st.technique_id = gt.technique_id and st.user_id = gt.user_id);

-- Every card on a game plan, once each: linked by someone, used by a step, or both. Read it through this view,
-- never through game_plan_techniques alone.
create or replace view game_plan_cards as
select game_plan_id, technique_id, user_id, bool_or(linked) as linked, bool_or(not linked) as in_steps
from (
  select game_plan_id, technique_id, user_id, true as linked from game_plan_techniques
  union all
  select game_plan_id, technique_id, user_id, false as linked from game_plan_steps where technique_id is not null
) cards
group by game_plan_id, technique_id, user_id;
