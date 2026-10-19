import type { Queryable } from '../db.js';
import { cleanUrl, instagramPost } from '../shared/links.js';
import { resolveTechnique, type Candidate } from '../resolve.js';
import type { SessionView } from '../shared/api.js';
import { sessionPhrase } from '../shared/sessions.js';
import { insertAttachments, mediaTag, type AttachmentInput } from './attachments.js';
import { logActivity, NOTE_SNAPSHOT_SQL, type NoteRowSnapshot, type SessionChange, type UndoOp } from './activity.js';
import { today, type Ctx } from './context.js';
import { findOrCreateSession, sessionById, type SessionDetails } from './sessions.js';
import { createStub } from './techniques.js';
import { UserError } from './errors.js';
import { noteList } from './views.js';
import { guessSourceKind, type NoteKind, type Role, type SourceKind, type TechniqueType } from './vocab.js';

export interface SourceInput {
  kind?: SourceKind;
  url?: string;
  title?: string;
  author?: string;
  /** Where in a video, e.g. "4:32". */
  timestamp?: string;
}

export interface NewTechniqueInput {
  name: string;
  type: TechniqueType;
  role?: Role;
}

export interface AddNoteInput {
  text: string;
  techniques?: string[];
  /** Exact technique ids (from a picker); linked without fuzzy matching. */
  technique_ids?: number[];
  /** Techniques to create as new cards before linking (only for names that don't exist yet). */
  new_techniques?: NewTechniqueInput[];
  kind?: NoteKind;
  /** Defaults to the session's date, then today. */
  date?: string;
  source?: SourceInput;
  /** Where the note came from: an existing session, or null for none. */
  session_id?: number | null;
  /** Where the note came from: a session to find or create. */
  session?: OriginInput;
  /** Not tried yet ("silly Instagram bullshit"): kept in the To try list, out of the inbox, until kept or tossed. */
  to_try?: boolean;
  /** Star it: a recent, pertinent note to keep in front of you (in Lab). */
  starred?: boolean;
  raw_text?: string;
  via?: 'mcp' | 'capture' | 'web';
  /** An id the client made up for this note: saving again with the same id returns the first save. */
  client_id?: string;
  /** Photos and videos (references to Apple Photos, with a still image each). */
  attachments?: AttachmentInput[];
}

export interface OriginInput extends SessionDetails {
  /** Defaults to the note's date. */
  date?: string;
}

interface Origin {
  id: number | null;
  view: SessionView | null;
  change: SessionChange;
}

/**
 * The session a note should point at, or undefined when the caller didn't say (so nothing changes).
 * An explicit session wins; null means none.
 */
async function resolveOrigin(
  q: Queryable,
  noteDate: string,
  sessionId: number | null | undefined,
  session: OriginInput | undefined,
): Promise<Origin | undefined> {
  if (session) {
    const found = await findOrCreateSession(q, session.date ?? noteDate, session);
    return { id: found.id, view: found.view, change: found.created ? { createdId: found.id } : { before: found.before } };
  }
  if (sessionId === null) return { id: null, view: null, change: {} };
  if (sessionId !== undefined) return { id: sessionId, view: await sessionById(q, sessionId), change: {} };
  return undefined;
}

export interface AddNoteResult {
  noteId: number;
  linked: string[];
  created: string[];
  unresolved: { name: string; candidates: Candidate[] }[];
  inbox: boolean;
  toTry: boolean;
  message: string;
  /** This client_id was saved before; nothing new was written. */
  duplicate?: boolean;
  /** The attachments saved with the note, in the order given. */
  attachments?: { id: number; linked: boolean }[];
}

async function upsertSource(q: Queryable, input: SourceInput): Promise<number | null> {
  // Only web links are kept as links (javascript: and the like are dropped), minus share-tracking.
  const s = { ...input, url: cleanUrl(input.url) };
  const handle = s.url ? instagramPost(s.url)?.handle : undefined;
  if (handle && !s.author) s.author = `@${handle}`;
  const kind = s.kind ?? (s.url ? guessSourceKind(s.url) : undefined);
  if (!kind) return null;
  if (s.url) {
    const { rows } = await q.query<{ id: number }>(
      `insert into sources (kind, url, title, author) values ($1, $2, $3, $4)
       on conflict (url) do update set
         title = coalesce(excluded.title, sources.title),
         author = coalesce(excluded.author, sources.author)
       returning id`,
      [kind, s.url, s.title ?? null, s.author ?? null],
    );
    return rows[0]!.id;
  }
  if (!s.title && !s.author) return null; // a bare "from class" is covered by the session
  // The same book or set of class notes is one source, however many notes cite it.
  const same = await q.query<{ id: number }>(
    `select id from sources where url is null and kind = $1
       and title is not distinct from $2 and author is not distinct from $3 order by id limit 1`,
    [kind, s.title ?? null, s.author ?? null],
  );
  if (same.rows[0]) return same.rows[0].id;
  const { rows } = await q.query<{ id: number }>(
    'insert into sources (kind, title, author) values ($1, $2, $3) returning id',
    [kind, s.title ?? null, s.author ?? null],
  );
  return rows[0]!.id;
}

/** Links names to techniques; creates the requested new ones. Returns ids plus what couldn't be matched. */
async function linkTechniques(q: Queryable, names: string[], newOnes: NewTechniqueInput[], exactIds: number[] = []) {
  const ids = new Map<number, string>();
  const created: { id: number; name: string }[] = [];
  const unresolved: { name: string; candidates: Candidate[] }[] = [];

  if (exactIds.length) {
    const { rows } = await q.query<{ id: number; name: string }>('select id, name from techniques where id = any($1::int[])', [
      exactIds,
    ]);
    for (const r of rows) ids.set(r.id, r.name);
  }

  for (const n of newOnes) {
    const existing = await resolveTechnique(q, n.name);
    if (existing.match?.exact) {
      ids.set(existing.match.id, existing.match.name);
      continue;
    }
    const id = await createStub(q, n.name, n.type, n.role);
    created.push({ id, name: n.name.trim() });
    ids.set(id, n.name.trim());
  }
  for (const name of names) {
    if (!name.trim()) continue;
    const r = await resolveTechnique(q, name);
    if (r.match) ids.set(r.match.id, r.match.name);
    else unresolved.push({ name, candidates: r.candidates });
  }
  return { ids, created, unresolved };
}

export async function addNote(ctx: Ctx, input: AddNoteInput): Promise<AddNoteResult> {
  return ctx.db.tx(async q => {
    const text = input.text.trim();
    if (!text) throw new UserError('Note text is empty.');
    if (input.client_id) {
      const seen = (
        await q.query<{ id: number; inbox: boolean; to_try: boolean; names: string[] | null }>(
          `select n.id, n.inbox, n.to_try,
                  (select array_agg(t.name order by t.name) from note_techniques nt join techniques t on t.id = nt.technique_id
                    where nt.note_id = n.id) as names
           from notes n where n.client_id = $1`,
          [input.client_id],
        )
      ).rows[0];
      if (seen) {
        return {
          noteId: seen.id,
          linked: seen.names ?? [],
          created: [],
          unresolved: [],
          inbox: seen.inbox,
          toTry: seen.to_try,
          message: `Already saved as note #${seen.id}.`,
          duplicate: true,
        };
      }
    }
    const date = input.date ?? input.session?.date ?? today(ctx);
    const { ids, created, unresolved } = await linkTechniques(
      q,
      input.techniques ?? [],
      input.new_techniques ?? [],
      input.technique_ids ?? [],
    );
    const sourceId = input.source ? await upsertSource(q, input.source) : null;
    const origin = await resolveOrigin(q, date, input.session_id, input.session);
    let sessionId = origin?.id ?? null;
    if (!origin) {
      // Nothing said: a note from a day with exactly one session is from that session.
      const sessions = (await q.query<{ id: number }>('select id from sessions where date = $1', [date])).rows;
      sessionId = sessions.length === 1 ? sessions[0]!.id : null;
    }
    const toTry = input.to_try === true;
    const inbox = !toTry && (ids.size === 0 || unresolved.length > 0);

    const { rows } = await q.query<{ id: number }>(
      `insert into notes (body, raw_text, kind, observed_on, session_id, source_id, source_timestamp, inbox, to_try, created_via, starred_at,
                          client_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $11 then now() end, $12) returning id`,
      [
        text,
        input.raw_text ?? null,
        input.kind ?? 'instruction',
        date,
        sessionId,
        sourceId,
        input.source?.timestamp ?? null,
        inbox,
        toTry,
        input.via ?? 'mcp',
        input.starred === true,
        input.client_id ?? null,
      ],
    );
    const noteId = rows[0]!.id;
    for (const id of ids.keys()) {
      await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2)', [noteId, id]);
    }
    const attachments = input.attachments?.length ? await insertAttachments(q, noteId, input.attachments) : undefined;

    const linked = [...ids.values()];
    const from = origin?.view ? ` (from ${sessionPhrase(origin.view)})` : '';
    const saved = toTry
      ? `Added note #${noteId} to try${linked.length ? ` (about ${linked.join(', ')})` : ''}`
      : linked.length
        ? `Saved note #${noteId} to ${linked.join(', ')}`
        : `Saved note #${noteId}`;
    const parts = [saved + from + (input.starred ? ', starred' : '')];
    if (created.length) parts.push(`new card${created.length > 1 ? 's' : ''}: ${created.map(c => c.name).join(', ')}`);
    for (const u of unresolved) {
      parts.push(
        u.candidates.length
          ? `couldn't place "${u.name}" (closest: ${u.candidates.map(c => c.name).join(', ')})`
          : `"${u.name}" isn't a known technique`,
      );
    }
    if (inbox) parts.push('left in the inbox to file later');
    const message = parts.join('; ') + '.';

    await logActivity(q, 'add_note', `note #${noteId}${linked.length ? ` on ${linked.join(', ')}` : ''}`, {
      kind: 'delete_note',
      noteId,
      createdTechniqueIds: created.map(c => c.id),
      session: origin?.change,
    });
    return { noteId, linked, created: created.map(c => c.name), unresolved, inbox, toTry, message, attachments };
  });
}

/** Links a note to techniques and takes it out of the inbox, or off the To try list (keeping it). */
export async function fileNote(
  ctx: Ctx,
  noteId: number,
  techniques: string[],
  newTechniques: NewTechniqueInput[] = [],
  techniqueIds: number[] = [],
): Promise<string> {
  return ctx.db.tx(async q => {
    const note = (
      await q.query<{ id: number; inbox: boolean; to_try: boolean }>('select id, inbox, to_try from notes where id = $1', [noteId])
    ).rows[0];
    if (!note) return `No note #${noteId}.`;
    const before = (
      await q.query<{ technique_id: number }>('select technique_id from note_techniques where note_id = $1', [noteId])
    ).rows.map(r => r.technique_id);
    const { ids, created, unresolved } = await linkTechniques(q, techniques, newTechniques, techniqueIds);
    for (const id of ids.keys()) {
      await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2) on conflict do nothing', [noteId, id]);
    }
    const total = new Set([...before, ...ids.keys()]).size;
    const inbox = total === 0 || unresolved.length > 0;
    await q.query('update notes set inbox = $2, to_try = false where id = $1', [noteId, inbox]);
    await logActivity(q, 'file_note', `${note.to_try ? 'keeping' : 'filing'} note #${noteId}`, {
      kind: 'refile_note',
      noteId,
      inbox: note.inbox,
      toTry: note.to_try,
      techniqueIds: before,
      createdTechniqueIds: created.map(c => c.id),
    });
    const parts = [`${note.to_try ? 'Kept' : 'Filed'} note #${noteId}${note.to_try ? ', filed' : ''} under ${[...ids.values()].join(', ') || 'nothing new'}`];
    for (const u of unresolved) {
      parts.push(`couldn't place "${u.name}"${u.candidates.length ? ` (closest: ${u.candidates.map(c => c.name).join(', ')})` : ''}`);
    }
    if (inbox) parts.push('still in the inbox');
    return parts.join('; ') + '.';
  });
}

export async function getInbox(ctx: Ctx, limit = 10, toTry = false): Promise<string> {
  const rows = toTry
    ? await noteList(ctx.db, { toTry: true, limit })
    : await noteList(ctx.db, { inbox: true, limit, oldestFirst: true });
  if (!rows.length) return toTry ? 'Nothing waiting to be tried.' : 'Inbox is empty.';
  const total = (await ctx.db.query<{ c: number }>(`select count(*)::int as c from notes where ${toTry ? 'to_try' : 'inbox'}`)).rows[0]!.c;
  const heading = toTry
    ? `${total} to try (newest first)${total > rows.length ? `, showing ${rows.length}` : ''}:`
    : `${total} note${total === 1 ? '' : 's'} in the inbox${total > rows.length ? ` (showing ${rows.length})` : ''}:`;
  return [
    heading,
    ...rows.map(r => {
      const about = r.techniques.length ? ` [${toTry ? 'about' : 'linked'}: ${r.techniques.map(t => t.name).join(', ')}]` : '';
      const link = r.source?.url ? ` <${r.source.url}>` : '';
      return `- #${r.id} (${r.observedOn}): ${r.body}${about}${mediaTag(r.attachments)}${link}`;
    }),
  ].join('\n');
}

export interface UpdateNoteInput {
  body?: string;
  kind?: NoteKind;
  /** YYYY-MM-DD */
  observed_on?: string;
  /** Replaces the linked techniques. An empty list sends the note to the inbox. */
  technique_ids?: number[];
  /** New cards to create and link as well (with technique_ids, or added to the current ones). */
  new_techniques?: NewTechniqueInput[];
  /** Where the note came from: an existing session, or null for none. */
  session_id?: number | null;
  /** Where the note came from: a session to find or create (dated like the note unless given). */
  session?: OriginInput;
  /** Put it on (true) or take it off (false) the To try list. Off with no techniques means it needs filing. */
  to_try?: boolean;
  /** Star (true) or unstar (false). */
  starred?: boolean;
  /** Mark a question answered (true) or open again (false). */
  answered?: boolean;
}

export async function updateNote(ctx: Ctx, id: number, input: UpdateNoteInput): Promise<string> {
  return ctx.db.tx(async q => {
    const row = (await q.query<NoteRowSnapshot>(NOTE_SNAPSHOT_SQL, [id])).rows[0];
    if (!row) return `No note #${id}.`;
    const before = (
      await q.query<{ technique_id: number }>('select technique_id from note_techniques where note_id = $1', [id])
    ).rows.map(r => r.technique_id);
    const body = input.body !== undefined ? input.body.trim() : row.body;
    if (!body) throw new UserError('Note text is empty.');
    const observedOn = input.observed_on ?? row.observed_on;
    const origin = await resolveOrigin(q, observedOn, input.session_id, input.session);
    await q.query('update notes set body = $2, kind = $3, observed_on = $4, session_id = $5 where id = $1', [
      id,
      body,
      input.kind ?? row.kind,
      observedOn,
      origin ? origin.id : row.session_id,
    ]);
    const fresh = input.new_techniques?.length ? await linkTechniques(q, [], input.new_techniques) : null;
    if (input.technique_ids || fresh) {
      const ids = new Set([...(input.technique_ids ?? before), ...(fresh ? fresh.ids.keys() : [])]);
      await q.query('delete from note_techniques where note_id = $1', [id]);
      const { rows } = await q.query<{ id: number }>('select id from techniques where id = any($1::int[])', [[...ids]]);
      for (const t of rows) {
        await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2)', [id, t.id]);
      }
    }
    // A to-try note waits out of the inbox; otherwise a note with no techniques needs filing.
    const wasToTry = row.to_try ?? false;
    const toTry = input.to_try ?? wasToTry;
    if (input.technique_ids || fresh || toTry !== wasToTry) {
      const count = (await q.query<{ c: number }>('select count(*)::int as c from note_techniques where note_id = $1', [id])).rows[0]!.c;
      await q.query('update notes set inbox = $2, to_try = $3 where id = $1', [id, !toTry && count === 0, toTry]);
    }
    const wasStarred = !!row.starred_at;
    if (input.starred !== undefined && input.starred !== wasStarred) {
      await q.query('update notes set starred_at = case when $2 then now() end where id = $1', [id, input.starred]);
    }
    const starChange = input.starred === undefined || input.starred === wasStarred ? null : input.starred ? 'starred' : 'unstarred';
    const wasAnswered = !!row.answered_at;
    const answerChange = input.answered === undefined || input.answered === wasAnswered ? null : input.answered ? 'answered' : 'open again';
    if (answerChange) {
      await q.query('update notes set answered_at = case when $2 then now() end where id = $1', [id, input.answered]);
    }
    const action =
      wasToTry && !toTry
        ? 'keeping'
        : answerChange === 'answered'
          ? 'answering'
          : answerChange
            ? 'reopening'
            : starChange === 'starred'
              ? 'starring'
              : starChange === 'unstarred'
                ? 'unstarring'
                : 'edit to';
    await logActivity(q, 'update_note', `${action} note #${id}`, {
      kind: 'restore_note',
      row,
      techniqueIds: before,
      session: origin?.change,
      createdTechniqueIds: fresh?.created.map(c => c.id),
    });
    const moved =
      (toTry === wasToTry ? '' : toTry ? ', now on the To try list' : ', off the To try list') +
      (starChange ? `, ${starChange}` : '') +
      (answerChange ? `, ${answerChange === 'answered' ? 'marked answered' : answerChange}` : '');
    if (origin?.view) return `Updated note #${id} (from ${sessionPhrase(origin.view)})${moved}.`;
    return origin ? `Updated note #${id} (no session)${moved}.` : `Updated note #${id}${moved}.`;
  });
}

/** Removes one note and returns how to put it back; null if it doesn't exist. */
async function removeNote(q: Queryable, id: number): Promise<UndoOp | null> {
  const row = (await q.query<NoteRowSnapshot>(NOTE_SNAPSHOT_SQL, [id])).rows[0];
  if (!row) return null;
  const techniqueIds = (
    await q.query<{ technique_id: number }>('select technique_id from note_techniques where note_id = $1', [id])
  ).rows.map(r => r.technique_id);
  const attachmentIds = (await q.query<{ id: number }>('select id from attachments where note_id = $1', [id])).rows.map(r => r.id);
  await q.query('delete from notes where id = $1', [id]);
  return { kind: 'restore_note', row, techniqueIds, ...(attachmentIds.length ? { attachmentIds } : {}) };
}

export async function deleteNote(ctx: Ctx, id: number): Promise<string> {
  return ctx.db.tx(async q => {
    const undo = await removeNote(q, id);
    if (!undo) return `No note #${id}.`;
    await logActivity(q, 'delete_note', `deleting note #${id}`, undo);
    return `Deleted note #${id}.`;
  });
}

/** Deletes several notes as one change: a single undo brings them all back. */
export async function deleteNotes(ctx: Ctx, ids: number[]): Promise<string> {
  return ctx.db.tx(async q => {
    const ops: UndoOp[] = [];
    for (const id of new Set(ids)) {
      const undo = await removeNote(q, id);
      if (undo) ops.push(undo);
    }
    if (!ops.length) return 'Nothing to delete.';
    if (ops.length === 1) {
      const id = (ops[0] as { row: NoteRowSnapshot }).row.id;
      await logActivity(q, 'delete_note', `deleting note #${id}`, ops[0]!);
      return `Deleted note #${id}.`;
    }
    await logActivity(q, 'delete_notes', `deleting ${ops.length} notes`, { kind: 'batch', ops });
    return `Deleted ${ops.length} notes.`;
  });
}
