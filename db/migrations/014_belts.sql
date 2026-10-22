-- Everyone's belt: it colours their app. The owner keeps the purple the app has always had; anyone
-- invited before belts existed starts at white and can change it on their Account page.
alter table users add column if not exists belt text not null default 'white'
  check (belt in ('white', 'blue', 'purple', 'brown', 'black'));
update users set belt = 'purple' where is_owner;

-- The belt an invite is for (null for password resets).
alter table invites add column if not exists belt text
  check (belt in ('white', 'blue', 'purple', 'brown', 'black'));
