import type { Queryable } from '../db.js';
import { resolveTechnique, type Candidate } from '../resolve.js';
import { logActivity } from './activity.js';
import { today, type Ctx } from './context.js';
import { createStub } from './techniques.js';
import { guessSourceKind, isoDate, type NoteKind, type Role, type SourceKind, type TechniqueType } from './vocab.js';

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

async function upsertSource(q: Queryable, s: SourceInput): Promise<number | null> {
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
async function linkTechniques(q: Queryable, names: string[], newOnes: NewTechniqueInput[]) {
  const ids = new Map<number, string>();
  const created: { id: number; name: string }[] = [];
  const unresolved: { name: string; candidates: Candidate[] }[] = [];

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
    if (!text) throw new Error('Note text is empty.');
    const date = input.date ?? today(ctx);
    const { ids, created, unresolved } = await linkTechniques(q, input.techniques ?? [], input.new_techniques ?? []);
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
): Promise<string> {
  return ctx.db.tx(async q => {
    const note = (await q.query<{ id: number; inbox: boolean }>('select id, inbox from notes where id = $1', [noteId])).rows[0];
    if (!note) return `No note #${noteId}.`;
    const before = (
      await q.query<{ technique_id: number }>('select technique_id from note_techniques where note_id = $1', [noteId])
    ).rows.map(r => r.technique_id);
    const { ids, created, unresolved } = await linkTechniques(q, techniques, newTechniques);
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
  const rows = (
    await ctx.db.query<{ id: number; body: string; observed_on: string; techniques: string[] | null }>(
      `select n.id, n.body, n.observed_on::text as observed_on,
              array_remove(array_agg(t.name order by t.name), null) as techniques
       from notes n
       left join note_techniques nt on nt.note_id = n.id
       left join techniques t on t.id = nt.technique_id
       where n.inbox group by n.id order by n.id limit $1`,
      [limit],
    )
  ).rows;
  if (!rows.length) return 'Inbox is empty.';
  const total = (await ctx.db.query<{ c: number }>('select count(*)::int as c from notes where inbox')).rows[0]!.c;
  return [
    `${total} note${total === 1 ? '' : 's'} in the inbox${total > rows.length ? ` (showing ${rows.length})` : ''}:`,
    ...rows.map(
      r => `- #${r.id} (${isoDate(r.observed_on)}): ${r.body}${r.techniques?.length ? ` [linked: ${r.techniques.join(', ')}]` : ''}`,
    ),
  ].join('\n');
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
