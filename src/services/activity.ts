import { uid, type Db, type Queryable } from '../db.js';

export interface TechniqueSnapshot {
  id: number;
  name: string;
  aliases: string[];
  type: string;
  role: string | null;
  gi: string;
  status: string;
  summary: string | null;
  key_details: string[];
  mistakes: string[];
  /** Absent in undo entries written before techniques could be starred. */
  starred_at?: string | null;
}

/** An area's place on the focus list. */
export interface FocusSnapshot {
  id: number;
  rank: number | null;
  /** Only in undo entries written before areas, when the focus list had statuses (only 'active' was ranked). */
  status?: string;
  /** Only in undo entries written before goals were folded into descriptions. */
  goal?: string | null;
}

/** Links between an area and techniques or notes. */
export interface AreaLinkIds {
  techniques: number[];
  notes: number[];
}

/** An area's own fields, to put back after an edit. */
export interface AreaSnapshot {
  id: number;
  name: string;
  aliases: string[];
  description: string | null;
  start_position_id: number | null;
  start_role: string | null;
  premise: string | null;
}

/** One step of a plan as stored. */
export interface StepSnapshot {
  id: number;
  parent_id: number | null;
  ordinal: number;
  trigger: string | null;
  action: string;
  technique_id: number | null;
  to_position_id: number | null;
  to_role: string | null;
  note: string | null;
}

export const STEP_SNAPSHOT_SQL = `select id, parent_id, ordinal, trigger, action, technique_id, to_position_id, to_role, note
  from area_steps where area_id = $1 and user_id = $2 order by id`;

/** A session's details, to put back after they were filled in. */
export interface SessionSnapshot {
  id: number;
  name: string | null;
  instructor: string | null;
  location: string | null;
  gi: string | null;
  summary: string | null;
}

/** What a write did to sessions while setting a note's origin. */
export interface SessionChange {
  createdId?: number;
  before?: SessionSnapshot | null;
}

/** Everything needed to reverse one write. */
export type UndoOp =
  | { kind: 'delete_note'; noteId: number; createdTechniqueIds: number[]; session?: SessionChange }
  | { kind: 'delete_techniques'; techniqueIds: number[] }
  | {
      kind: 'restore_technique';
      before: TechniqueSnapshot;
      addedEdgeIds: number[];
      addedLinks: { from: number; to: number; kind: string }[];
      createdTechniqueIds: number[];
    }
  /** Puts the focus list back: ranks as they were, minus the events and links the change added (and the area it made). */
  | {
      kind: 'restore_focus';
      items: FocusSnapshot[];
      /** An area the change created. */
      deleteItemId: number | null;
      eventIds: number[];
      addedLinks: { item: number; technique: number }[];
    }
  /** Undoes log_session: detaches the notes it attached, then deletes the session (if it made it) or restores its details. */
  | { kind: 'delete_session'; sessionId: number; attachedNoteIds: number[]; created?: boolean; before?: SessionSnapshot | null }
  | { kind: 'refile_note'; noteId: number; inbox: boolean; toTry?: boolean; techniqueIds: number[]; createdTechniqueIds: number[] }
  /** Puts a note back exactly as it was (after an edit or a delete). */
  | {
      kind: 'restore_note';
      row: NoteRowSnapshot;
      techniqueIds: number[];
      session?: SessionChange;
      createdTechniqueIds?: number[];
      /** Photos and videos to link to the note again. */
      attachmentIds?: number[];
      /** The areas it was filed under (absent in older entries, and when an edit left them alone). Area ids. */
      focusItemIds?: number[];
    }
  | { kind: 'restore_edge'; edge: EdgeSnapshot }
  | { kind: 'restore_link'; link: LinkSnapshot }
  /** Recreates a deleted technique with everything that pointed at it. */
  | {
      kind: 'restore_deleted_technique';
      row: TechniqueSnapshot & { created_at: string; updated_at: string };
      edges: EdgeSnapshot[];
      links: LinkSnapshot[];
      noteIds: number[];
      /** Areas it was linked to (area ids). */
      focusItemIds: number[];
      /** Plan steps that were this technique (absent in older entries). */
      stepIds?: number[];
      /** Notes that went to the inbox because this was their only technique. */
      inboxedNoteIds?: number[];
    }
  /** Puts an area's title and description back (older entries carry a goal instead). */
  | { kind: 'restore_focus_label'; itemId: number; label: string; description?: string | null; goal?: string | null }
  /** Takes back links added to an area and puts back ones removed. */
  | { kind: 'restore_focus_links'; itemId: number; added: AreaLinkIds; removed: AreaLinkIds }
  /** Puts an area's fields back, and its plan when `steps` is given. */
  | { kind: 'restore_area'; before: AreaSnapshot; steps?: StepSnapshot[] }
  /** Recreates a deleted area with its links, plan and focus history, back at its place on the focus list. */
  | {
      kind: 'restore_deleted_area';
      row: AreaSnapshot & { rank: number | null; goal: string | null; created_at: string; updated_at: string };
      techniqueIds: number[];
      noteIds: number[];
      steps: StepSnapshot[];
      events: { id: number; event: string; from_status: string | null; to_status: string | null; from_rank: number | null; to_rank: number | null; at: string }[];
    }
  /** Puts stars (or answered marks) back as they were after clearing several at once. */
  | { kind: 'restore_marks'; mark: 'starred' | 'answered'; notes: MarkSnapshot[]; techniques: MarkSnapshot[] }
  /** Several writes made as one (e.g. deleting a selection); undone together, last first. */
  | { kind: 'batch'; ops: UndoOp[] };

export interface NoteRowSnapshot {
  id: number;
  body: string;
  raw_text: string | null;
  kind: string;
  observed_on: string;
  session_id: number | null;
  source_id: number | null;
  source_timestamp: string | null;
  inbox: boolean;
  /** Absent in undo entries written before the To try list existed. */
  to_try?: boolean;
  starred_at?: string | null;
  answered_at?: string | null;
  created_via: string;
  created_at: string;
}

/** A mark (a star, or a question's answered mark) as it was on one row, to put back. */
export interface MarkSnapshot {
  id: number;
  at: string | null;
}

export interface EdgeSnapshot {
  id: number;
  technique_id: number;
  from_position_id: number | null;
  from_role: string | null;
  to_position_id: number | null;
  to_role: string | null;
}

export interface LinkSnapshot {
  from_id: number;
  to_id: number;
  kind: string;
  note: string | null;
}

export const NOTE_SNAPSHOT_SQL = `select id, body, raw_text, kind, observed_on::text as observed_on, session_id, source_id,
  source_timestamp, inbox, to_try, starred_at::text as starred_at, answered_at::text as answered_at, created_via,
  created_at::text as created_at from notes where id = $1 and user_id = $2`;

export async function logActivity(q: Queryable, action: string, summary: string, undo: UndoOp): Promise<void> {
  await q.query('insert into activity_log (action, summary, undo, user_id) values ($1, $2, $3, $4)', [
    action,
    summary,
    JSON.stringify(undo),
    uid(q),
  ]);
}

async function insertEdge(q: Queryable, e: EdgeSnapshot) {
  await q.query(
    `insert into technique_edges (id, technique_id, from_position_id, from_role, to_position_id, to_role)
     select $1, $2, $3, $4, $5, $6 where exists (select 1 from techniques where id = $2 and user_id = $7)
     on conflict do nothing`,
    [e.id, e.technique_id, e.from_position_id, e.from_role, e.to_position_id, e.to_role, uid(q)],
  );
}

async function insertLink(q: Queryable, l: LinkSnapshot) {
  await q.query('insert into technique_links (from_id, to_id, kind, note, user_id) values ($1, $2, $3, $4, $5) on conflict do nothing', [
    l.from_id,
    l.to_id,
    l.kind,
    l.note,
    uid(q),
  ]);
}

async function deleteTechniques(q: Queryable, ids: number[]) {
  if (ids.length) await q.query('delete from techniques where id = any($1::int[]) and user_id = $2', [ids, uid(q)]);
}

async function restoreSession(q: Queryable, s: SessionSnapshot) {
  await q.query('update sessions set name = $2, instructor = $3, location = $4, gi = $5, summary = $6 where id = $1 and user_id = $7', [
    s.id,
    s.name,
    s.instructor,
    s.location,
    s.gi,
    s.summary,
    uid(q),
  ]);
}

/** Runs after the note itself is put back, so a session made for it has nothing pointing at it. */
async function revertSessionChange(q: Queryable, c: SessionChange | undefined) {
  if (c?.before) await restoreSession(q, c.before);
  if (c?.createdId) await q.query('delete from sessions where id = $1 and user_id = $2', [c.createdId, uid(q)]);
}

async function apply(q: Queryable, op: UndoOp): Promise<void> {
  const me = uid(q);
  switch (op.kind) {
    case 'delete_note':
      await q.query('delete from attachments where note_id = $1 and user_id = $2', [op.noteId, me]);
      await q.query('delete from notes where id = $1 and user_id = $2', [op.noteId, me]);
      await deleteTechniques(q, op.createdTechniqueIds);
      await revertSessionChange(q, op.session);
      return;
    case 'delete_techniques':
      await deleteTechniques(q, op.techniqueIds);
      return;
    case 'restore_technique': {
      const b = op.before;
      await q.query(
        `update techniques set name = $2, aliases = $3, type = $4, role = $5, gi = $6, status = $7,
           summary = $8, key_details = $9, mistakes = $10, updated_at = now(),
           starred_at = case when $12 then $11::timestamptz else starred_at end
         where id = $1 and user_id = $13`,
        [b.id, b.name, b.aliases, b.type, b.role, b.gi, b.status, b.summary, b.key_details, b.mistakes, b.starred_at ?? null, b.starred_at !== undefined, me],
      );
      if (op.addedEdgeIds.length) {
        await q.query(
          'delete from technique_edges where id = any($1::int[]) and technique_id in (select id from techniques where user_id = $2)',
          [op.addedEdgeIds, me],
        );
      }
      for (const l of op.addedLinks) {
        await q.query('delete from technique_links where from_id = $1 and to_id = $2 and kind = $3 and user_id = $4', [l.from, l.to, l.kind, me]);
      }
      await deleteTechniques(q, op.createdTechniqueIds);
      return;
    }
    case 'restore_focus':
      if (op.eventIds.length) {
        await q.query('delete from focus_events where id = any($1::int[]) and area_id in (select id from areas where user_id = $2)', [
          op.eventIds,
          me,
        ]);
      }
      for (const l of op.addedLinks) {
        await q.query('delete from area_techniques where area_id = $1 and technique_id = $2 and user_id = $3', [l.item, l.technique, me]);
      }
      if (op.deleteItemId !== null) await q.query('delete from areas where id = $1 and user_id = $2', [op.deleteItemId, me]);
      // Everything comes off first, so putting ranks back never collides.
      await q.query('update areas set rank = null where user_id = $1 and rank is not null', [me]);
      for (const s of op.items) {
        const rank = s.status === undefined || s.status === 'active' ? s.rank : null;
        await q.query('update areas set rank = $2, updated_at = now() where id = $1 and user_id = $3', [s.id, rank, me]);
        if (s.goal !== undefined) await q.query('update areas set goal = $2 where id = $1 and user_id = $3', [s.id, s.goal, me]);
      }
      return;
    case 'delete_session':
      if (op.attachedNoteIds.length) {
        await q.query('update notes set session_id = null where id = any($1::int[]) and user_id = $2', [op.attachedNoteIds, me]);
      }
      if (op.before) await restoreSession(q, op.before);
      if (op.created !== false) await q.query('delete from sessions where id = $1 and user_id = $2', [op.sessionId, me]);
      return;
    case 'restore_note': {
      const r = op.row;
      await q.query(
        `insert into notes (id, body, raw_text, kind, observed_on, session_id, source_id, source_timestamp, inbox, to_try, created_via, created_at,
                            starred_at, answered_at, user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (id) do update set body = excluded.body, raw_text = excluded.raw_text, kind = excluded.kind,
           observed_on = excluded.observed_on, session_id = excluded.session_id, source_id = excluded.source_id,
           source_timestamp = excluded.source_timestamp, inbox = excluded.inbox, to_try = excluded.to_try,
           starred_at = excluded.starred_at, answered_at = excluded.answered_at
         where notes.user_id = excluded.user_id`,
        [
          r.id,
          r.body,
          r.raw_text,
          r.kind,
          r.observed_on,
          r.session_id,
          r.source_id,
          r.source_timestamp,
          r.inbox,
          r.to_try ?? false,
          r.created_via,
          r.created_at,
          r.starred_at ?? null,
          r.answered_at ?? null,
          me,
        ],
      );
      await q.query('delete from note_techniques where note_id = $1 and user_id = $2', [r.id, me]);
      for (const t of op.techniqueIds) {
        await insertNoteTechnique(q, r.id, t);
      }
      await revertSessionChange(q, op.session);
      await deleteTechniques(q, op.createdTechniqueIds ?? []);
      if (op.attachmentIds?.length) {
        await q.query('update attachments set note_id = $1 where id = any($2::int[]) and user_id = $3', [r.id, op.attachmentIds, me]);
      }
      if (op.focusItemIds) {
        await q.query('delete from area_notes where note_id = $1 and user_id = $2', [r.id, me]);
        for (const f of op.focusItemIds) await insertAreaNote(q, f, r.id);
      }
      return;
    }
    case 'restore_edge':
      await insertEdge(q, op.edge);
      return;
    case 'restore_link':
      await insertLink(q, op.link);
      return;
    case 'restore_deleted_technique': {
      const r = op.row;
      await q.query(
        `insert into techniques (id, name, aliases, type, role, gi, status, summary, key_details, mistakes, created_at, updated_at, starred_at,
                                 user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          r.id,
          r.name,
          r.aliases,
          r.type,
          r.role,
          r.gi,
          r.status,
          r.summary,
          r.key_details,
          r.mistakes,
          r.created_at,
          r.updated_at,
          r.starred_at ?? null,
          me,
        ],
      );
      for (const e of op.edges) await insertEdge(q, e);
      for (const l of op.links) await insertLink(q, l);
      for (const n of op.noteIds) await insertNoteTechnique(q, n, r.id);
      for (const f of op.focusItemIds) {
        // Only areas that are still there: one may have been deleted since.
        await q.query(
          `insert into area_techniques (area_id, technique_id, user_id)
           select $1, $2, $3 where exists (select 1 from areas where id = $1 and user_id = $3) on conflict do nothing`,
          [f, r.id, me],
        );
      }
      if (op.stepIds?.length) {
        await q.query('update area_steps set technique_id = $2 where id = any($1::int[]) and user_id = $3', [op.stepIds, r.id, me]);
      }
      if (op.inboxedNoteIds?.length) {
        await q.query('update notes set inbox = false where id = any($1::int[]) and user_id = $2', [op.inboxedNoteIds, me]);
      }
      return;
    }
    case 'batch':
      for (const inner of [...op.ops].reverse()) await apply(q, inner);
      return;
    case 'restore_marks': {
      const col = op.mark === 'starred' ? 'starred_at' : 'answered_at';
      for (const n of op.notes) await q.query(`update notes set ${col} = $2::timestamptz where id = $1 and user_id = $3`, [n.id, n.at, me]);
      if (op.mark === 'starred') {
        for (const t of op.techniques) {
          await q.query('update techniques set starred_at = $2::timestamptz where id = $1 and user_id = $3', [t.id, t.at, me]);
        }
      }
      return;
    }
    case 'restore_focus_label':
      await q.query('update areas set name = $2, updated_at = now() where id = $1 and user_id = $3', [op.itemId, op.label, me]);
      if (op.description !== undefined) {
        await q.query('update areas set description = $2 where id = $1 and user_id = $3', [op.itemId, op.description, me]);
      }
      if (op.goal !== undefined) await q.query('update areas set goal = $2 where id = $1 and user_id = $3', [op.itemId, op.goal, me]);
      return;
    case 'restore_focus_links':
      if (op.added.techniques.length) {
        await q.query('delete from area_techniques where area_id = $1 and technique_id = any($2::int[]) and user_id = $3', [
          op.itemId,
          op.added.techniques,
          me,
        ]);
      }
      if (op.added.notes.length) {
        await q.query('delete from area_notes where area_id = $1 and note_id = any($2::int[]) and user_id = $3', [op.itemId, op.added.notes, me]);
        await refreshInbox(q, op.added.notes);
      }
      for (const t of op.removed.techniques) await insertAreaTechnique(q, op.itemId, t);
      for (const n of op.removed.notes) await insertAreaNote(q, op.itemId, n);
      if (op.removed.notes.length) await refreshInbox(q, op.removed.notes);
      return;
    case 'restore_area': {
      const b = op.before;
      await q.query(
        `update areas set name = $2, aliases = $3, description = $4, start_position_id = $5, start_role = $6, premise = $7, updated_at = now()
         where id = $1 and user_id = $8`,
        [b.id, b.name, b.aliases, b.description, b.start_position_id, b.start_role, b.premise, me],
      );
      if (op.steps) {
        await q.query('delete from area_steps where area_id = $1 and user_id = $2', [b.id, me]);
        await insertSteps(q, b.id, op.steps);
      }
      return;
    }
    case 'restore_deleted_area': {
      const r = op.row;
      // Back at its old place on the focus list: what's there now moves down one.
      if (r.rank !== null) await q.query('update areas set rank = rank + 1 where user_id = $1 and rank >= $2', [me, r.rank]);
      await q.query(
        `insert into areas (id, name, aliases, description, start_position_id, start_role, premise, rank, goal, created_at, updated_at, user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [r.id, r.name, r.aliases, r.description, r.start_position_id, r.start_role, r.premise, r.rank, r.goal, r.created_at, r.updated_at, me],
      );
      for (const t of op.techniqueIds) await insertAreaTechnique(q, r.id, t);
      for (const n of op.noteIds) await insertAreaNote(q, r.id, n);
      await refreshInbox(q, op.noteIds);
      await insertSteps(q, r.id, op.steps);
      for (const e of op.events) {
        await q.query(
          `insert into focus_events (id, area_id, event, from_status, to_status, from_rank, to_rank, at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [e.id, r.id, e.event, e.from_status, e.to_status, e.from_rank, e.to_rank, e.at],
        );
      }
      await renumberFocus(q);
      return;
    }
    case 'refile_note':
      await q.query('delete from note_techniques where note_id = $1 and user_id = $2', [op.noteId, me]);
      for (const t of op.techniqueIds) await insertNoteTechnique(q, op.noteId, t);
      await q.query('update notes set inbox = $2, to_try = $3 where id = $1 and user_id = $4', [op.noteId, op.inbox, op.toTry ?? false, me]);
      await deleteTechniques(q, op.createdTechniqueIds);
      return;
  }
}

/** Files a note under an area again, if both are still there. */
async function insertAreaNote(q: Queryable, areaId: number, noteId: number) {
  await q.query(
    `insert into area_notes (area_id, note_id, user_id)
     select $1, $2, $3
     where exists (select 1 from areas where id = $1 and user_id = $3) and exists (select 1 from notes where id = $2 and user_id = $3)
     on conflict do nothing`,
    [areaId, noteId, uid(q)],
  );
}

/** Links a technique to an area again, if both are still there. */
async function insertAreaTechnique(q: Queryable, areaId: number, techniqueId: number) {
  await q.query(
    `insert into area_techniques (area_id, technique_id, user_id)
     select $1, $2, $3
     where exists (select 1 from areas where id = $1 and user_id = $3) and exists (select 1 from techniques where id = $2 and user_id = $3)
     on conflict do nothing`,
    [areaId, techniqueId, uid(q)],
  );
}

/** Puts plan steps back with their ids. A step whose technique card has since been deleted keeps its words. */
export async function insertSteps(q: Queryable, areaId: number, steps: StepSnapshot[]): Promise<void> {
  const me = uid(q);
  for (const st of steps) {
    await q.query(
      `insert into area_steps (id, area_id, user_id, parent_id, ordinal, trigger, action, technique_id, to_position_id, to_role, note)
       values ($1, $2, $3, null, $4, $5, $6, (select id from techniques where id = $7 and user_id = $3), $8, $9, $10)`,
      [st.id, areaId, me, st.ordinal, st.trigger, st.action, st.technique_id, st.to_position_id, st.to_role, st.note],
    );
  }
  for (const st of steps) {
    if (st.parent_id !== null) await q.query('update area_steps set parent_id = $2 where id = $1 and user_id = $3', [st.id, st.parent_id, me]);
  }
}

/**
 * Notes are in the inbox when nothing files them: no technique and no area. Rechecks the given notes after
 * their areas changed (To try notes stay out of the inbox).
 */
export async function refreshInbox(q: Queryable, noteIds: number[]): Promise<void> {
  if (!noteIds.length) return;
  await q.query(
    `update notes n set inbox = not n.to_try
       and not exists (select 1 from note_techniques x where x.note_id = n.id)
       and not exists (select 1 from area_notes y where y.note_id = n.id)
     where n.id = any($1::int[]) and n.user_id = $2`,
    [noteIds, uid(q)],
  );
}

/** Closes gaps in the focus list so it runs 1, 2, 3... */
export async function renumberFocus(q: Queryable): Promise<void> {
  await q.query(
    `update areas a set rank = r.pos
     from (select id, row_number() over (order by rank, id)::int as pos from areas where user_id = $1 and rank is not null) r
     where a.id = r.id and a.rank is distinct from r.pos`,
    [uid(q)],
  );
}

/** Links a note to a technique again, if both are still there. */
async function insertNoteTechnique(q: Queryable, noteId: number, techniqueId: number) {
  await q.query(
    `insert into note_techniques (note_id, technique_id, user_id)
     select $1, $2, $3
     where exists (select 1 from notes where id = $1 and user_id = $3) and exists (select 1 from techniques where id = $2 and user_id = $3)
     on conflict do nothing`,
    [noteId, techniqueId, uid(q)],
  );
}

/** Reverses the user's most recent write that hasn't been undone yet. */
export async function undoLast(db: Db): Promise<string> {
  return db.tx(async q => {
    const { rows } = await q.query<{ id: number; summary: string; undo: UndoOp | string }>(
      'select id, summary, undo from activity_log where user_id = $1 and not undone order by id desc limit 1 for update',
      [uid(q)],
    );
    const row = rows[0];
    if (!row) return 'Nothing to undo.';
    const op = typeof row.undo === 'string' ? (JSON.parse(row.undo) as UndoOp) : row.undo;
    await apply(q, op);
    await q.query('update activity_log set undone = true where id = $1', [row.id]);
    return `Undid: ${row.summary}`;
  });
}
