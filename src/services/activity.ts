import type { Db, Queryable } from '../db.js';

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
}

export interface FocusSnapshot {
  id: number;
  status: string;
  rank: number | null;
  goal: string | null;
}

/** Everything needed to reverse one write. */
export type UndoOp =
  | { kind: 'delete_note'; noteId: number; createdTechniqueIds: number[] }
  | { kind: 'delete_techniques'; techniqueIds: number[] }
  | {
      kind: 'restore_technique';
      before: TechniqueSnapshot;
      addedEdgeIds: number[];
      addedLinks: { from: number; to: number; kind: string }[];
      createdTechniqueIds: number[];
    }
  | {
      kind: 'restore_focus';
      items: FocusSnapshot[];
      deleteItemId: number | null;
      eventIds: number[];
      addedLinks: { item: number; technique: number }[];
    }
  | { kind: 'delete_session'; sessionId: number; attachedNoteIds: number[] }
  | { kind: 'refile_note'; noteId: number; inbox: boolean; techniqueIds: number[]; createdTechniqueIds: number[] }
  /** Puts a note back exactly as it was (after an edit or a delete). */
  | { kind: 'restore_note'; row: NoteRowSnapshot; techniqueIds: number[] }
  | { kind: 'restore_edge'; edge: EdgeSnapshot }
  | { kind: 'restore_link'; link: LinkSnapshot }
  /** Recreates a deleted technique with everything that pointed at it. */
  | {
      kind: 'restore_deleted_technique';
      row: TechniqueSnapshot & { created_at: string; updated_at: string };
      edges: EdgeSnapshot[];
      links: LinkSnapshot[];
      noteIds: number[];
      focusItemIds: number[];
      /** Notes that went to the inbox because this was their only technique. */
      inboxedNoteIds?: number[];
    }
  | { kind: 'restore_focus_label'; itemId: number; label: string; goal: string | null };

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
  created_via: string;
  created_at: string;
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
  source_timestamp, inbox, created_via, created_at::text as created_at from notes where id = $1`;

export async function logActivity(q: Queryable, action: string, summary: string, undo: UndoOp): Promise<void> {
  await q.query('insert into activity_log (action, summary, undo) values ($1, $2, $3)', [
    action,
    summary,
    JSON.stringify(undo),
  ]);
}

async function insertEdge(q: Queryable, e: EdgeSnapshot) {
  await q.query(
    `insert into technique_edges (id, technique_id, from_position_id, from_role, to_position_id, to_role)
     values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
    [e.id, e.technique_id, e.from_position_id, e.from_role, e.to_position_id, e.to_role],
  );
}

async function insertLink(q: Queryable, l: LinkSnapshot) {
  await q.query('insert into technique_links (from_id, to_id, kind, note) values ($1, $2, $3, $4) on conflict do nothing', [
    l.from_id,
    l.to_id,
    l.kind,
    l.note,
  ]);
}

async function deleteTechniques(q: Queryable, ids: number[]) {
  if (ids.length) await q.query('delete from techniques where id = any($1::int[])', [ids]);
}

async function apply(q: Queryable, op: UndoOp): Promise<void> {
  switch (op.kind) {
    case 'delete_note':
      await q.query('delete from notes where id = $1', [op.noteId]);
      await deleteTechniques(q, op.createdTechniqueIds);
      return;
    case 'delete_techniques':
      await deleteTechniques(q, op.techniqueIds);
      return;
    case 'restore_technique': {
      const b = op.before;
      await q.query(
        `update techniques set name = $2, aliases = $3, type = $4, role = $5, gi = $6, status = $7,
           summary = $8, key_details = $9, mistakes = $10, updated_at = now() where id = $1`,
        [b.id, b.name, b.aliases, b.type, b.role, b.gi, b.status, b.summary, b.key_details, b.mistakes],
      );
      if (op.addedEdgeIds.length) await q.query('delete from technique_edges where id = any($1::int[])', [op.addedEdgeIds]);
      for (const l of op.addedLinks) {
        await q.query('delete from technique_links where from_id = $1 and to_id = $2 and kind = $3', [l.from, l.to, l.kind]);
      }
      await deleteTechniques(q, op.createdTechniqueIds);
      return;
    }
    case 'restore_focus':
      if (op.eventIds.length) await q.query('delete from focus_events where id = any($1::int[])', [op.eventIds]);
      for (const l of op.addedLinks) {
        await q.query('delete from focus_item_techniques where focus_item_id = $1 and technique_id = $2', [l.item, l.technique]);
      }
      if (op.deleteItemId !== null) await q.query('delete from focus_items where id = $1', [op.deleteItemId]);
      for (const s of op.items) {
        await q.query('update focus_items set status = $2, rank = $3, goal = $4, updated_at = now() where id = $1', [
          s.id,
          s.status,
          s.rank,
          s.goal,
        ]);
      }
      return;
    case 'delete_session':
      if (op.attachedNoteIds.length) {
        await q.query('update notes set session_id = null where id = any($1::int[])', [op.attachedNoteIds]);
      }
      await q.query('delete from sessions where id = $1', [op.sessionId]);
      return;
    case 'restore_note': {
      const r = op.row;
      await q.query(
        `insert into notes (id, body, raw_text, kind, observed_on, session_id, source_id, source_timestamp, inbox, created_via, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (id) do update set body = excluded.body, raw_text = excluded.raw_text, kind = excluded.kind,
           observed_on = excluded.observed_on, session_id = excluded.session_id, source_id = excluded.source_id,
           source_timestamp = excluded.source_timestamp, inbox = excluded.inbox`,
        [r.id, r.body, r.raw_text, r.kind, r.observed_on, r.session_id, r.source_id, r.source_timestamp, r.inbox, r.created_via, r.created_at],
      );
      await q.query('delete from note_techniques where note_id = $1', [r.id]);
      for (const t of op.techniqueIds) {
        await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2) on conflict do nothing', [r.id, t]);
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
        `insert into techniques (id, name, aliases, type, role, gi, status, summary, key_details, mistakes, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [r.id, r.name, r.aliases, r.type, r.role, r.gi, r.status, r.summary, r.key_details, r.mistakes, r.created_at, r.updated_at],
      );
      for (const e of op.edges) await insertEdge(q, e);
      for (const l of op.links) await insertLink(q, l);
      for (const n of op.noteIds) {
        await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2) on conflict do nothing', [n, r.id]);
      }
      for (const f of op.focusItemIds) {
        await q.query('insert into focus_item_techniques (focus_item_id, technique_id) values ($1, $2) on conflict do nothing', [f, r.id]);
      }
      if (op.inboxedNoteIds?.length) {
        await q.query('update notes set inbox = false where id = any($1::int[])', [op.inboxedNoteIds]);
      }
      return;
    }
    case 'restore_focus_label':
      await q.query('update focus_items set label = $2, goal = $3, updated_at = now() where id = $1', [op.itemId, op.label, op.goal]);
      return;
    case 'refile_note':
      await q.query('delete from note_techniques where note_id = $1', [op.noteId]);
      for (const t of op.techniqueIds) {
        await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2)', [op.noteId, t]);
      }
      await q.query('update notes set inbox = $2 where id = $1', [op.noteId, op.inbox]);
      await deleteTechniques(q, op.createdTechniqueIds);
      return;
  }
}

/** Reverses the most recent write that hasn't been undone yet. */
export async function undoLast(db: Db): Promise<string> {
  return db.tx(async q => {
    const { rows } = await q.query<{ id: number; summary: string; undo: UndoOp | string }>(
      'select id, summary, undo from activity_log where not undone order by id desc limit 1 for update',
    );
    const row = rows[0];
    if (!row) return 'Nothing to undo.';
    const op = typeof row.undo === 'string' ? (JSON.parse(row.undo) as UndoOp) : row.undo;
    await apply(q, op);
    await q.query('update activity_log set undone = true where id = $1', [row.id]);
    return `Undid: ${row.summary}`;
  });
}
