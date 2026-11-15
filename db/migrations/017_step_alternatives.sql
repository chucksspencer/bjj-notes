-- "Or": a step of a plan can be an alternative to the step before it (same parent, next ordinal):
-- plan A, then plan B, in order of preference. An alternative has no trigger of its own (it answers the
-- same reaction as the step it's an alternative to) and has its own steps under it. On the main line,
-- the next step follows whichever alternative was used.
alter table area_steps add column if not exists alt boolean not null default false;
