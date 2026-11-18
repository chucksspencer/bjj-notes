// The activity log: every write records how to take itself back. The snapshot shapes and the UndoOp union are here,
// with `logActivity`; reversing them is in undo.ts.
import { uid, type Queryable } from '../db.js';

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

/** One of someone's own positions, as stored. */
export interface PositionSnapshot {
  id: number;
  slug: string;
  name: string;
  category: string;
  aliases: string[];
  description: string | null;
}

/** A game plan's place on the focus list. */
export interface FocusSnapshot {
  id: number;
  rank: number | null;
}

/** Links between a game plan and techniques or notes. */
export interface GamePlanLinkIds {
  techniques: number[];
  notes: number[];
}

/** A game plan's own fields, to put back after an edit. */
export interface GamePlanSnapshot {
  id: number;
  name: string;
  aliases: string[];
  description: string | null;
  start_position_id: number | null;
  start_role: string | null;
  premise: string | null;
}

/** One step of a game plan as stored. */
export interface StepSnapshot {
  id: number;
  parent_id: number | null;
  /** Its slot among the steps under the same parent (1 = first). */
  ordinal: number;
  /** Its place in the slot: 0 is plan A. Entries from before slots and options have `alt` instead, and can't be undone. */
  option: number;
  trigger: string | null;
  action: string;
  technique_id: number | null;
  to_position_id: number | null;
  to_role: string | null;
  note: string | null;
}

export const STEP_SNAPSHOT_SQL = `select id, parent_id, ordinal, option, trigger, action, technique_id, to_position_id, to_role, note
  from game_plan_steps where game_plan_id = $1 and user_id = $2 order by id`;

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
  /** Puts the focus list back: ranks as they were, minus the events the change added (and the game plan it made). */
  | {
      kind: 'restore_focus';
      items: FocusSnapshot[];
      /** A game plan the change created. */
      deleteGamePlanId: number | null;
      eventIds: number[];
    }
  /** Undoes log_session: detaches the notes it attached, then deletes the session (if it made it) or restores its details. */
  | { kind: 'delete_session'; sessionId: number; attachedNoteIds: number[]; created?: boolean; before?: SessionSnapshot | null }
  | {
      kind: 'refile_note';
      noteId: number;
      /** Whether a technique it named couldn't be placed (entries from before 022 have `inbox` instead). */
      unplaced?: boolean;
      /** Entries from before 022: the stored inbox flag, read as `unplaced` when the note had techniques. */
      inbox?: boolean;
      toTry?: boolean;
      techniqueIds: number[];
      createdTechniqueIds: number[];
    }
  /** Puts a note back exactly as it was (after an edit or a delete). */
  | {
      kind: 'restore_note';
      row: NoteRowSnapshot;
      techniqueIds: number[];
      session?: SessionChange;
      createdTechniqueIds?: number[];
      /** Photos and videos to link to the note again. */
      attachmentIds?: number[];
      /** The game plans it was filed under (absent in older entries, and when an edit left them alone). */
      gamePlanIds?: number[];
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
      /** Game plans someone linked it to. */
      linkedGamePlanIds?: number[];
      /**
       * Entries from before 022: game plans it was on, linked or used by a step (absent before 018). Ones whose
       * restored steps use it get it back through the steps; the rest are linked again.
       */
      gamePlanIds?: number[];
      /** Game plan steps that were this technique (absent in older entries). */
      stepIds?: number[];
      /** Entries from before 022: notes that went to the inbox. Ignored: the inbox follows from the links put back. */
      inboxedNoteIds?: number[];
    }
  /** Takes back links added to a game plan and puts back ones removed. */
  | { kind: 'restore_game_plan_links'; gamePlanId: number; added: GamePlanLinkIds; removed: GamePlanLinkIds }
  /** Puts a game plan's fields back, and its steps when `steps` is given. */
  | { kind: 'restore_game_plan'; before: GamePlanSnapshot; steps?: StepSnapshot[] }
  /** Recreates a deleted game plan with its links, steps and focus history, back at its place on the focus list. */
  | {
      kind: 'restore_deleted_game_plan';
      /** Entries from before migration 019 also carry `goal`, which is ignored. */
      row: GamePlanSnapshot & { rank: number | null; created_at: string; updated_at: string };
      /** The cards someone linked to it (the ones its steps use come back with the steps). */
      linkedTechniqueIds?: number[];
      /** Entries from before 022: every card on it, linked or used by a step. Ones its steps use aren't linked again. */
      techniqueIds?: number[];
      noteIds: number[];
      steps: StepSnapshot[];
      /** Entries from before 019 may have the older events (paused, resumed...) and from_status/to_status, which are ignored. */
      events: { id: number; event: string; from_rank: number | null; to_rank: number | null; at: string }[];
    }
  /** Puts stars (or answered marks) back as they were after clearing several at once. */
  | { kind: 'restore_marks'; mark: 'starred' | 'answered'; notes: MarkSnapshot[]; techniques: MarkSnapshot[] }
  /** Takes back a position someone added (refused if something uses it by then). */
  | { kind: 'delete_position'; positionId: number }
  /** Puts one of someone's own positions back as it was before an edit. */
  | { kind: 'restore_position'; before: PositionSnapshot }
  /** Recreates one of someone's own positions after it was deleted (nothing used it). */
  | { kind: 'restore_deleted_position'; row: PositionSnapshot }
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
  /** Absent in entries from before 022, which have `inbox` instead. */
  unplaced?: boolean;
  /** Entries from before 022: the stored inbox flag. Only read to tell whether a filed note had an unplaced name. */
  inbox?: boolean;
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
  source_timestamp, unplaced, to_try, starred_at::text as starred_at, answered_at::text as answered_at, created_via,
  created_at::text as created_at from notes where id = $1 and user_id = $2`;

/** Records a write so it can be undone. Returns the entry's id (also added to the request's collector, if the handle has one). */
export async function logActivity(q: Queryable, action: string, summary: string, undo: UndoOp): Promise<number> {
  const { rows } = await q.query<{ id: number }>('insert into activity_log (action, summary, undo, user_id) values ($1, $2, $3, $4) returning id', [
    action,
    summary,
    JSON.stringify(undo),
    uid(q),
  ]);
  const id = rows[0]!.id;
  q.activityIds?.push(id);
  return id;
}
