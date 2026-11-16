-- Areas are called game plans, everywhere: the tables, their columns, and every index, constraint and sequence
-- whose name still said area or focus item (some date back to 001). Names only: no row changes.

alter table areas rename to game_plans;
alter table area_steps rename to game_plan_steps;
alter table area_techniques rename to game_plan_techniques;
alter table area_notes rename to game_plan_notes;

alter table game_plan_steps rename column area_id to game_plan_id;
alter table game_plan_techniques rename column area_id to game_plan_id;
alter table game_plan_notes rename column area_id to game_plan_id;
alter table focus_events rename column area_id to game_plan_id;

-- A serial column's default points at its sequence by oid, so renaming the sequence is safe.
alter sequence if exists focus_items_id_seq rename to game_plans_id_seq;
alter sequence if exists area_steps_id_seq rename to game_plan_steps_id_seq;

alter index if exists areas_start rename to game_plans_start;
alter index if exists areas_user rename to game_plans_user;
alter index if exists area_steps_area rename to game_plan_steps_game_plan;
alter index if exists area_steps_technique rename to game_plan_steps_technique;
alter index if exists area_steps_to rename to game_plan_steps_to;
alter index if exists area_steps_user rename to game_plan_steps_user;
alter index if exists area_notes_note rename to game_plan_notes_note;
alter index if exists area_notes_user rename to game_plan_notes_user;

-- Constraints (renaming a primary key or unique constraint renames its index too). There's no
-- "rename constraint if exists", so each is renamed only where it's there under its old name.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('game_plans', 'focus_items_pkey', 'game_plans_pkey'),
      ('game_plans', 'areas_id_user', 'game_plans_id_user'),
      ('game_plans', 'areas_start_position_id_fkey', 'game_plans_start_position_id_fkey'),
      ('game_plans', 'areas_start_role_check', 'game_plans_start_role_check'),
      ('game_plans', 'focus_items_user_id_fkey', 'game_plans_user_id_fkey'),
      ('game_plan_steps', 'area_steps_pkey', 'game_plan_steps_pkey'),
      ('game_plan_steps', 'area_steps_id_area', 'game_plan_steps_id_game_plan'),
      ('game_plan_steps', 'area_steps_area_id_user_id_fkey', 'game_plan_steps_game_plan_id_user_id_fkey'),
      ('game_plan_steps', 'area_steps_parent_id_area_id_fkey', 'game_plan_steps_parent_id_game_plan_id_fkey'),
      ('game_plan_steps', 'area_steps_technique_id_user_id_fkey', 'game_plan_steps_technique_id_user_id_fkey'),
      ('game_plan_steps', 'area_steps_to_position_id_fkey', 'game_plan_steps_to_position_id_fkey'),
      ('game_plan_steps', 'area_steps_to_role_check', 'game_plan_steps_to_role_check'),
      ('game_plan_steps', 'area_steps_user_id_fkey', 'game_plan_steps_user_id_fkey'),
      ('game_plan_techniques', 'focus_item_techniques_pkey', 'game_plan_techniques_pkey'),
      ('game_plan_techniques', 'focus_item_techniques_focus_item_id_user_id_fkey', 'game_plan_techniques_game_plan_id_user_id_fkey'),
      ('game_plan_techniques', 'focus_item_techniques_technique_id_user_id_fkey', 'game_plan_techniques_technique_id_user_id_fkey'),
      ('game_plan_techniques', 'focus_item_techniques_user_id_fkey', 'game_plan_techniques_user_id_fkey'),
      ('game_plan_notes', 'focus_item_notes_pkey', 'game_plan_notes_pkey'),
      ('game_plan_notes', 'focus_item_notes_focus_item_id_user_id_fkey', 'game_plan_notes_game_plan_id_user_id_fkey'),
      ('game_plan_notes', 'focus_item_notes_note_id_user_id_fkey', 'game_plan_notes_note_id_user_id_fkey'),
      ('game_plan_notes', 'focus_item_notes_user_id_fkey', 'game_plan_notes_user_id_fkey'),
      ('focus_events', 'focus_events_focus_item_id_fkey', 'focus_events_game_plan_id_fkey')
    ) as t (tbl, old_name, new_name)
  loop
    if exists (select 1 from pg_constraint where conrelid = r.tbl::regclass and conname = r.old_name) then
      execute format('alter table %I rename constraint %I to %I', r.tbl, r.old_name, r.new_name);
    end if;
  end loop;

  -- Newer Postgres versions name not-null constraints too (focus_items_label_not_null,
  -- area_steps_area_id_not_null...). Older ones don't, so these are found rather than listed.
  for r in
    select c.conrelid::regclass::text as tbl, c.conname as old_name,
           regexp_replace(regexp_replace(regexp_replace(regexp_replace(c.conname,
             '^focus_items_', 'game_plans_'), '^areas_', 'game_plans_'),
             '^(focus_item|area)_(steps|techniques|notes)_', 'game_plan_\2_'),
             '(focus_item|area)_id', 'game_plan_id') as new_name
    from pg_constraint c
    where c.contype = 'n'
      and c.conrelid in ('game_plans'::regclass, 'game_plan_steps'::regclass, 'game_plan_techniques'::regclass,
                         'game_plan_notes'::regclass, 'focus_events'::regclass)
      and c.conname ~ '(focus_item|area)'
  loop
    -- focus_items_label_not_null: the column has been "name" since 016.
    if r.old_name = 'focus_items_label_not_null' then
      r.new_name := 'game_plans_name_not_null';
    end if;
    execute format('alter table %I rename constraint %I to %I', r.tbl, r.old_name, r.new_name);
  end loop;
end $$;
