-- Videos and ideas to try before they earn a place in the library ("silly Instagram bullshit").
-- A to-try note stays out of the inbox until it's kept (filed under a technique) or tossed (deleted).
alter table notes add column if not exists to_try boolean not null default false;
create index if not exists notes_to_try on notes (created_at desc) where to_try;

-- Links saved without a takeaway so far were waiting to be tried.
update notes set to_try = true, inbox = false
where inbox and source_id is not null
  and body in ('Instagram reel to review.', 'Video to review.', 'Link to review.');
