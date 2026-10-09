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
  | { kind: 'refile_note'; noteId: number; inbox: boolean; techniqueIds: number[]; createdTechniqueIds: number[] };

export async function logActivity(q: Queryable, action: string, summary: string, undo: UndoOp): Promise<void> {
  await q.query('insert into activity_log (action, summary, undo) values ($1, $2, $3)', [
    action,
    summary,
    JSON.stringify(undo),
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
