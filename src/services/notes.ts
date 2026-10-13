import type { Queryable } from '../db.js';
import { resolveTechnique, type Candidate } from '../resolve.js';
import { logActivity, NOTE_SNAPSHOT_SQL, type NoteRowSnapshot } from './activity.js';
import { today, type Ctx } from './context.js';
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
  date?: string;
  source?: SourceInput;
  raw_text?: string;
  via?: 'mcp' | 'capture' | 'web';
}

export interface AddNoteResult {
  noteId: number;
  linked: string[];
  created: string[];
  unresolved: { name: string; candidates: Candidate[] }[];
  inbox: boolean;
  message: string;
}

/** Only web links are kept as links; anything else (e.g. javascript:) is dropped. */
function safeUrl(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

async function upsertSource(q: Queryable, input: SourceInput): Promise<number | null> {
  const s = { ...input, url: safeUrl(input.url) };
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
    const date = input.date ?? today(ctx);
    const { ids, created, unresolved } = await linkTechniques(
      q,
      input.techniques ?? [],
      input.new_techniques ?? [],
      input.technique_ids ?? [],
    );
    const sourceId = input.source ? await upsertSource(q, input.source) : null;
    const sessions = (await q.query<{ id: number }>('select id from sessions where date = $1', [date])).rows;
    const sessionId = sessions.length === 1 ? sessions[0]!.id : null;
    const inbox = ids.size === 0 || unresolved.length > 0;

    const { rows } = await q.query<{ id: number }>(
      `insert into notes (body, raw_text, kind, observed_on, session_id, source_id, source_timestamp, inbox, created_via)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        text,
        input.raw_text ?? null,
        input.kind ?? 'instruction',
        date,
        sessionId,
        sourceId,
        input.source?.timestamp ?? null,
        inbox,
        input.via ?? 'mcp',
      ],
    );
    const noteId = rows[0]!.id;
    for (const id of ids.keys()) {
      await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2)', [noteId, id]);
    }

    const linked = [...ids.values()];
    const parts = [linked.length ? `Saved note #${noteId} to ${linked.join(', ')}` : `Saved note #${noteId}`];
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
    });
    return { noteId, linked, created: created.map(c => c.name), unresolved, inbox, message };
  });
}

/** Links an inbox note to techniques and takes it out of the inbox. */
export async function fileNote(
  ctx: Ctx,
  noteId: number,
  techniques: string[],
  newTechniques: NewTechniqueInput[] = [],
  techniqueIds: number[] = [],
): Promise<string> {
  return ctx.db.tx(async q => {
    const note = (await q.query<{ id: number; inbox: boolean }>('select id, inbox from notes where id = $1', [noteId])).rows[0];
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
    await q.query('update notes set inbox = $2 where id = $1', [noteId, inbox]);
    await logActivity(q, 'file_note', `filing note #${noteId}`, {
      kind: 'refile_note',
      noteId,
      inbox: note.inbox,
      techniqueIds: before,
      createdTechniqueIds: created.map(c => c.id),
    });
    const parts = [`Filed note #${noteId} under ${[...ids.values()].join(', ') || 'nothing new'}`];
    for (const u of unresolved) {
      parts.push(`couldn't place "${u.name}"${u.candidates.length ? ` (closest: ${u.candidates.map(c => c.name).join(', ')})` : ''}`);
    }
    if (inbox) parts.push('still in the inbox');
    return parts.join('; ') + '.';
  });
}

export async function getInbox(ctx: Ctx, limit = 10): Promise<string> {
  const rows = await noteList(ctx.db, { inbox: true, limit, oldestFirst: true });
  if (!rows.length) return 'Inbox is empty.';
  const total = (await ctx.db.query<{ c: number }>('select count(*)::int as c from notes where inbox')).rows[0]!.c;
  return [
    `${total} note${total === 1 ? '' : 's'} in the inbox${total > rows.length ? ` (showing ${rows.length})` : ''}:`,
    ...rows.map(
      r =>
        `- #${r.id} (${r.observedOn}): ${r.body}${r.techniques.length ? ` [linked: ${r.techniques.map(t => t.name).join(', ')}]` : ''}`,
    ),
  ].join('\n');
}

export interface UpdateNoteInput {
  body?: string;
  kind?: NoteKind;
  /** YYYY-MM-DD */
  observed_on?: string;
  /** Replaces the linked techniques. An empty list sends the note to the inbox. */
  technique_ids?: number[];
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
    await q.query('update notes set body = $2, kind = $3, observed_on = $4 where id = $1', [
      id,
      body,
      input.kind ?? row.kind,
      input.observed_on ?? row.observed_on,
    ]);
    if (input.technique_ids) {
      await q.query('delete from note_techniques where note_id = $1', [id]);
      const { rows } = await q.query<{ id: number }>('select id from techniques where id = any($1::int[])', [input.technique_ids]);
      for (const t of rows) {
        await q.query('insert into note_techniques (note_id, technique_id) values ($1, $2)', [id, t.id]);
      }
      await q.query('update notes set inbox = $2 where id = $1', [id, rows.length === 0]);
    }
    await logActivity(q, 'update_note', `edit to note #${id}`, { kind: 'restore_note', row, techniqueIds: before });
    return `Updated note #${id}.`;
  });
}

export async function deleteNote(ctx: Ctx, id: number): Promise<string> {
  return ctx.db.tx(async q => {
    const row = (await q.query<NoteRowSnapshot>(NOTE_SNAPSHOT_SQL, [id])).rows[0];
    if (!row) return `No note #${id}.`;
    const techniqueIds = (
      await q.query<{ technique_id: number }>('select technique_id from note_techniques where note_id = $1', [id])
    ).rows.map(r => r.technique_id);
    await q.query('delete from notes where id = $1', [id]);
    await logActivity(q, 'delete_note', `deleting note #${id}`, { kind: 'restore_note', row, techniqueIds });
    return `Deleted note #${id}.`;
  });
}

export interface LogSessionInput {
  date?: string;
  kind?: 'class' | 'open_mat' | 'private' | 'seminar' | 'competition' | 'drilling' | 'other';
  gi?: 'gi' | 'nogi' | 'both';
  instructor?: string;
  location?: string;
  summary?: string;
}

export async function logSession(ctx: Ctx, input: LogSessionInput): Promise<string> {
  return ctx.db.tx(async q => {
    const date = input.date ?? today(ctx);
    const { rows } = await q.query<{ id: number }>(
      `insert into sessions (date, kind, gi, instructor, location, summary) values ($1, $2, $3, $4, $5, $6) returning id`,
      [date, input.kind ?? 'class', input.gi ?? null, input.instructor ?? null, input.location ?? null, input.summary ?? null],
    );
    const sessionId = rows[0]!.id;
    const attached = (
      await q.query<{ id: number }>(
        'update notes set session_id = $1 where observed_on = $2 and session_id is null returning id',
        [sessionId, date],
      )
    ).rows.map(r => r.id);
    const kind = (input.kind ?? 'class').replace('_', ' ');
    await logActivity(q, 'log_session', `${kind} on ${date}`, { kind: 'delete_session', sessionId, attachedNoteIds: attached });
    return `Logged ${kind} on ${date}${attached.length ? ` and attached ${attached.length} note${attached.length > 1 ? 's' : ''} from that day` : ''}.`;
  });
}
