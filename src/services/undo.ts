// Undo: puts back what an activity_log entry recorded. Each UndoOp kind (the shapes are in activity.ts) has its
// reversal in `apply`; `undo` picks the entry, checks this version still knows its ops, and marks it undone.
import { uid, type Db, type Queryable } from '../db.js';
import type { EdgeSnapshot, LinkSnapshot, SessionChange, SessionSnapshot, StepSnapshot, UndoOp } from './activity.js';
import { UserError } from './errors.js';
import { renumberFocus } from './focus.js';
import { restoreDeletedPosition, restorePosition, undoCreatePosition } from './positions.js';

/** Puts a position edge back, if its technique is still there. */
async function insertEdge(q: Queryable, e: EdgeSnapshot) {
  await q.query(
    `insert into technique_edges (id, technique_id, user_id, from_position_id, from_role, to_position_id, to_role)
     select $1, $2, $7, $3, $4, $5, $6 where exists (select 1 from techniques where id = $2 and user_id = $7)
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
          'delete from technique_edges where id = any($1::int[]) and user_id = $2',
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
        await q.query('delete from focus_events where id = any($1::int[]) and user_id = $2', [op.eventIds, me]);
      }
      if (op.deleteGamePlanId !== null) await q.query('delete from game_plans where id = $1 and user_id = $2', [op.deleteGamePlanId, me]);
      // Everything comes off first, so putting ranks back never collides.
      await q.query('update game_plans set rank = null where user_id = $1 and rank is not null', [me]);
      for (const s of op.items) {
        await q.query('update game_plans set rank = $2, updated_at = now() where id = $1 and user_id = $3', [s.id, s.rank, me]);
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
        `insert into notes (id, body, raw_text, kind, observed_on, session_id, source_id, source_timestamp, unplaced, to_try, created_via, created_at,
                            starred_at, answered_at, user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (id) do update set body = excluded.body, raw_text = excluded.raw_text, kind = excluded.kind,
           observed_on = excluded.observed_on, session_id = excluded.session_id, source_id = excluded.source_id,
           source_timestamp = excluded.source_timestamp, unplaced = excluded.unplaced, to_try = excluded.to_try,
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
          r.unplaced ?? (r.inbox === true && !r.to_try && (op.techniqueIds.length > 0 || (op.gamePlanIds?.length ?? 0) > 0)),
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
      if (op.gamePlanIds) {
        await q.query('delete from game_plan_notes where note_id = $1 and user_id = $2', [r.id, me]);
        for (const g of op.gamePlanIds) await insertGamePlanNote(q, g, r.id);
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
      if (op.stepIds?.length) {
        await q.query('update game_plan_steps set technique_id = $2 where id = any($1::int[]) and user_id = $3', [op.stepIds, r.id, me]);
      }
      // Only game plans that are still there: one may have been deleted since.
      for (const g of op.linkedGamePlanIds ?? []) await insertGamePlanTechnique(q, g, r.id);
      if (op.gamePlanIds?.length) {
        const viaSteps = new Set(
          (await q.query<{ game_plan_id: number }>('select distinct game_plan_id from game_plan_steps where technique_id = $1 and user_id = $2', [r.id, me])).rows.map(
            s => s.game_plan_id,
          ),
        );
        for (const g of op.gamePlanIds) if (!viaSteps.has(g)) await insertGamePlanTechnique(q, g, r.id);
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
    case 'restore_game_plan_links':
      if (op.added.techniques.length) {
        await q.query('delete from game_plan_techniques where game_plan_id = $1 and technique_id = any($2::int[]) and user_id = $3', [
          op.gamePlanId,
          op.added.techniques,
          me,
        ]);
      }
      if (op.added.notes.length) {
        await q.query('delete from game_plan_notes where game_plan_id = $1 and note_id = any($2::int[]) and user_id = $3', [
          op.gamePlanId,
          op.added.notes,
          me,
        ]);
      }
      for (const t of op.removed.techniques) await insertGamePlanTechnique(q, op.gamePlanId, t);
      for (const n of op.removed.notes) await insertGamePlanNote(q, op.gamePlanId, n);
      return;
    case 'restore_game_plan': {
      const b = op.before;
      await q.query(
        `update game_plans set name = $2, aliases = $3, description = $4, start_position_id = $5, start_role = $6, premise = $7, updated_at = now()
         where id = $1 and user_id = $8`,
        [b.id, b.name, b.aliases, b.description, b.start_position_id, b.start_role, b.premise, me],
      );
      if (op.steps) {
        await q.query('delete from game_plan_steps where game_plan_id = $1 and user_id = $2', [b.id, me]);
        await insertSteps(q, b.id, op.steps);
      }
      return;
    }
    case 'restore_deleted_game_plan': {
      const r = op.row;
      // Back at its old place on the focus list: what's there now moves down one.
      if (r.rank !== null) await q.query('update game_plans set rank = rank + 1 where user_id = $1 and rank >= $2', [me, r.rank]);
      await q.query(
        `insert into game_plans (id, name, aliases, description, start_position_id, start_role, premise, rank, created_at, updated_at, user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [r.id, r.name, r.aliases, r.description, r.start_position_id, r.start_role, r.premise, r.rank, r.created_at, r.updated_at, me],
      );
      for (const n of op.noteIds) await insertGamePlanNote(q, r.id, n);
      await insertSteps(q, r.id, op.steps);
      for (const t of op.linkedTechniqueIds ?? []) await insertGamePlanTechnique(q, r.id, t);
      const viaSteps = new Set(op.steps.map(st => st.technique_id));
      for (const t of op.techniqueIds ?? []) if (!viaSteps.has(t)) await insertGamePlanTechnique(q, r.id, t);
      for (const e of op.events) {
        await q.query(
          `insert into focus_events (id, game_plan_id, user_id, event, from_rank, to_rank, at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [e.id, r.id, me, focusEvent(e.event), e.from_rank, e.to_rank, e.at],
        );
      }
      await renumberFocus(q);
      return;
    }
    case 'delete_position':
      await undoCreatePosition(q, op.positionId);
      return;
    case 'restore_position':
      await restorePosition(q, op.before);
      return;
    case 'restore_deleted_position':
      await restoreDeletedPosition(q, op.row);
      return;
    case 'refile_note':
      await q.query('delete from note_techniques where note_id = $1 and user_id = $2', [op.noteId, me]);
      for (const t of op.techniqueIds) await insertNoteTechnique(q, op.noteId, t);
      await q.query('update notes set unplaced = $2, to_try = $3 where id = $1 and user_id = $4', [
        op.noteId,
        op.unplaced ?? (op.inbox === true && op.techniqueIds.length > 0),
        op.toTry ?? false,
        me,
      ]);
      await deleteTechniques(q, op.createdTechniqueIds);
      return;
  }
}

/** A focus event as it's stored now: the older ones (from when the list had statuses) as what they meant, as migration 019 did. */
const focusEvent = (event: string): string =>
  event === 'added' || event === 'moved' || event === 'removed' ? event : event === 'resumed' ? 'added' : 'removed';

/** Files a note under a game plan again, if both are still there. */
async function insertGamePlanNote(q: Queryable, gamePlanId: number, noteId: number) {
  await q.query(
    `insert into game_plan_notes (game_plan_id, note_id, user_id)
     select $1, $2, $3
     where exists (select 1 from game_plans where id = $1 and user_id = $3) and exists (select 1 from notes where id = $2 and user_id = $3)
     on conflict do nothing`,
    [gamePlanId, noteId, uid(q)],
  );
}

/** Links a technique to a game plan again, if both are still there. */
async function insertGamePlanTechnique(q: Queryable, gamePlanId: number, techniqueId: number) {
  await q.query(
    `insert into game_plan_techniques (game_plan_id, technique_id, user_id)
     select $1, $2, $3
     where exists (select 1 from game_plans where id = $1 and user_id = $3) and exists (select 1 from techniques where id = $2 and user_id = $3)
     on conflict do nothing`,
    [gamePlanId, techniqueId, uid(q)],
  );
}

/** Puts a game plan's steps back with their ids. A step whose technique card has since been deleted keeps its words. */
export async function insertSteps(q: Queryable, gamePlanId: number, steps: StepSnapshot[]): Promise<void> {
  const me = uid(q);
  for (const st of steps) {
    await q.query(
      `insert into game_plan_steps (id, game_plan_id, user_id, parent_id, ordinal, trigger, action, technique_id, to_position_id, to_role, note, option)
       values ($1, $2, $3, null, $4, $5, $6, (select id from techniques where id = $7 and user_id = $3), $8, $9, $10, $11)`,
      [st.id, gamePlanId, me, st.ordinal, st.trigger, st.action, st.technique_id, st.to_position_id, st.to_role, st.note, st.option],
    );
  }
  for (const st of steps) {
    if (st.parent_id !== null) await q.query('update game_plan_steps set parent_id = $2 where id = $1 and user_id = $3', [st.id, st.parent_id, me]);
  }
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

/** The undo ops this version knows (the compiler checks the list is complete). */
const UNDO_KINDS: Record<UndoOp['kind'], true> = {
  delete_note: true,
  delete_techniques: true,
  restore_technique: true,
  restore_focus: true,
  delete_session: true,
  refile_note: true,
  restore_note: true,
  restore_edge: true,
  restore_link: true,
  restore_deleted_technique: true,
  restore_game_plan_links: true,
  restore_game_plan: true,
  restore_deleted_game_plan: true,
  restore_marks: true,
  delete_position: true,
  restore_position: true,
  restore_deleted_position: true,
  batch: true,
};

/** Whether this version can undo an entry: older ones in the log may use ops that have since been renamed. */
const known = (op: UndoOp): boolean =>
  Object.hasOwn(UNDO_KINDS, op.kind) &&
  (op.kind !== 'batch' || op.ops.every(known)) &&
  // Steps saved before slots and options (020) say `alt`, not `option`: there's no telling where they'd go now.
  ((op.kind !== 'restore_game_plan' && op.kind !== 'restore_deleted_game_plan') || (op.steps ?? []).every(st => Number.isInteger(st.option)));

/**
 * Reverses the user's most recent write that hasn't been undone yet. With an id (the app's Undo button), it reverses
 * that entry only, and only while it is still the newest: if something else was written since, nothing changes.
 */
export async function undo(db: Db, id?: number): Promise<string> {
  return db.tx(async q => {
    const { rows } = await q.query<{ id: number; summary: string; undo: UndoOp | string }>(
      'select id, summary, undo from activity_log where user_id = $1 and not undone order by id desc limit 1 for update',
      [uid(q)],
    );
    const row = rows[0];
    if (id !== undefined && row?.id !== id) throw new UserError("Something else changed since then, so that can't be undone from here.");
    if (!row) return 'Nothing to undo.';
    const op = typeof row.undo === 'string' ? (JSON.parse(row.undo) as UndoOp) : row.undo;
    if (!known(op)) throw new UserError(`"${row.summary}" was saved by an older version of the app and can't be undone.`);
    await apply(q, op);
    await q.query('update activity_log set undone = true where id = $1 and user_id = $2', [row.id, uid(q)]);
    return `Undid: ${row.summary}`;
  });
}
