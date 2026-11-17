-- Steps as slots and options. Under one parent, `ordinal` is the slot (1, 2, 3...): a point in the game plan
-- where one thing is done. `option` is the alternative within the slot: 0 is plan A, 1 is plan B, and so on.
-- Until now an alternative was a row with `alt` set that had to sit right after its plan A; nothing enforced
-- that, and the grouping was worked out again wherever steps were read.
alter table game_plan_steps add column if not exists option int not null default 0;

-- Each list of siblings, in its old order: a step that isn't an alternative starts a slot, and each alternative
-- after it is the slot's next option. An alternative with nothing before it is a slot of its own.
with ordered as (
  select id, game_plan_id, parent_id, alt,
         row_number() over (partition by game_plan_id, parent_id order by ordinal, id) as rn
  from game_plan_steps
), slotted as (
  select id, game_plan_id, parent_id, rn,
         sum(case when alt and rn > 1 then 0 else 1 end) over (partition by game_plan_id, parent_id order by rn) as slot
  from ordered
), placed as (
  select id, slot::int as slot,
         (row_number() over (partition by game_plan_id, parent_id, slot order by rn) - 1)::int as opt
  from slotted
)
update game_plan_steps st set ordinal = p.slot, option = p.opt from placed p where p.id = st.id;

-- An alternative answers the same reaction as its plan A: only option 0 says what the reaction is.
update game_plan_steps set trigger = null where option > 0 and trigger is not null;

alter table game_plan_steps drop column alt;

drop index if exists game_plan_steps_game_plan;
-- One step per slot and option. Checked when the transaction commits: moving and deleting renumber a row at a
-- time. The main line has no parent, so nulls count as equal. Its index also serves reading a plan in order.
alter table game_plan_steps
  add constraint game_plan_steps_slot_option unique nulls not distinct (game_plan_id, parent_id, ordinal, option) deferrable initially deferred,
  add constraint game_plan_steps_ordinal_check check (ordinal >= 1),
  add constraint game_plan_steps_option_check check (option >= 0),
  add constraint game_plan_steps_option_trigger_check check (option = 0 or trigger is null);
