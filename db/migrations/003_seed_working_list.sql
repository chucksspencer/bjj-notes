-- Imports the BJJ working list as it stood on 2026-10-09, top item = most focused.
-- Labels are kept exactly as written; each is linked to a technique card.

insert into techniques (name, aliases, type, role, status) values
  ('Baratoplata',                         '{"barataplata"}',                    'submission', null,     'learning'),
  ('Shoulder crunch',                     '{"shoulder crunches"}',              'control',    'bottom', 'learning'),
  ('Body lock pass',                      '{"body lock passing", "bodylock pass"}', 'pass',   'top',    'learning'),
  ('Shoulder lock to paper cutter choke', '{"paper cutter combo"}',             'submission', 'bottom', 'learning'),
  ('Ghost escape',                        '{}',                                 'escape',     'bottom', 'learning'),
  ('Leg elevation',                       '{"deep half leg elevation"}',        'sweep',      'bottom', 'learning'),
  ('Ankle lock',                          '{"straight ankle lock"}',            'submission', null,     'learning');

insert into technique_edges (technique_id, from_position_id, from_role, to_position_id, to_role)
select t.id, p.id, e.from_role, null, e.to_role
from (values
  ('Shoulder crunch',                     'butterfly',    'bottom', null),
  ('Shoulder crunch',                     'half-guard',   'bottom', null),
  ('Shoulder lock to paper cutter choke', 'side-control', 'bottom', null),
  ('Ghost escape',                        'side-control', 'bottom', null),
  ('Leg elevation',                       'deep-half',    'bottom', 'top')
) as e(technique, position, from_role, to_role)
join techniques t on t.name = e.technique
join positions p on p.slug = e.position;

insert into focus_items (label, status, rank) values
  ('Baratoplata',                                                                 'active', 1),
  ('Shoulder crunches from butterfly guard and bottom half guard',                'active', 2),
  ('Body lock passing',                                                           'active', 3),
  ('Shoulder lock and paper cutter choke combination from bottom side control',   'active', 4),
  ('Ghost escape',                                                                'active', 5),
  ('Leg elevation from deep half guard',                                          'active', 6),
  ('Ankle lock adjustments',                                                      'active', 7);

insert into focus_item_techniques (focus_item_id, technique_id)
select f.id, t.id
from (values
  ('Baratoplata',                                                               'Baratoplata'),
  ('Shoulder crunches from butterfly guard and bottom half guard',              'Shoulder crunch'),
  ('Body lock passing',                                                         'Body lock pass'),
  ('Shoulder lock and paper cutter choke combination from bottom side control', 'Shoulder lock to paper cutter choke'),
  ('Ghost escape',                                                              'Ghost escape'),
  ('Leg elevation from deep half guard',                                        'Leg elevation'),
  ('Ankle lock adjustments',                                                    'Ankle lock')
) as m(label, technique)
join focus_items f on f.label = m.label
join techniques t on t.name = m.technique;

insert into focus_events (focus_item_id, event, to_status, to_rank)
select id, 'added', 'active', rank from focus_items;
