-- Custom positions: each person can add their own on top of the shared starter list.

-- A position with no user_id is a starter position: shared, read-only for everyone (the owner included), and
-- changed only by a migration. One with a user_id is that person's own, seen and used only in their notebook.
alter table positions add column if not exists user_id int references users (id) on delete cascade;
comment on column positions.user_id is
  'Whose position this is. Null for the starter positions everyone shares, which only a migration changes.';

-- Slugs were unique across everything; now they're unique per owner, the shared list counting as one owner. The code
-- also keeps a person's own slugs, names and aliases clear of the starter ones, so a slug names one position in what
-- each person sees. This index (user_id first) also serves the per-person list, so there's no other.
alter table positions drop constraint if exists positions_slug_key;
alter table positions add constraint positions_user_slug unique nulls not distinct (user_id, slug);

-- Someone else's position can't be used, down to the database: a technique's moves, where a game plan starts and
-- where a step leaves you may name a shared position or one of the row's owner's own. (A composite foreign key
-- can't say this, since shared positions have no user_id.) The arguments are the columns to check.
create or replace function bjj_position_visible() returns trigger language plpgsql as $$
declare
  col text;
  pid int;
begin
  foreach col in array tg_argv loop
    pid := (to_jsonb(new) ->> col)::int;
    if pid is not null and not exists (select 1 from positions p where p.id = pid and (p.user_id is null or p.user_id = new.user_id)) then
      raise exception 'position % is not one user % can use', pid, new.user_id using errcode = 'foreign_key_violation';
    end if;
  end loop;
  return null;
end
$$;

create constraint trigger technique_edges_position_visible
  after insert or update of from_position_id, to_position_id, user_id on technique_edges
  for each row execute function bjj_position_visible('from_position_id', 'to_position_id');
create constraint trigger game_plans_position_visible
  after insert or update of start_position_id, user_id on game_plans
  for each row execute function bjj_position_visible('start_position_id');
create constraint trigger game_plan_steps_position_visible
  after insert or update of to_position_id, user_id on game_plan_steps
  for each row execute function bjj_position_visible('to_position_id');
