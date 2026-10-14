import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { undoLast } from '../services/activity.js';
import type { Ctx } from '../services/context.js';
import { getLab, getPosition, review, search } from '../services/explore.js';
import { focusHistory, getFocus, updateFocus } from '../services/focus.js';
import { addNote, fileNote, getInbox, updateNote } from '../services/notes.js';
import { logSession } from '../services/sessions.js';
import { getTechnique, saveTechnique } from '../services/techniques.js';
import {
  FOCUS_ACTIONS,
  GI,
  LINK_KINDS,
  NOTE_KINDS,
  ROLES,
  SESSION_KINDS,
  SOURCE_KINDS,
  STATUSES,
  TECHNIQUE_TYPES,
} from '../services/vocab.js';

const INSTRUCTIONS = `Chuck's personal Brazilian jiu-jitsu notebook: technique cards organised as a position graph, dated notes from classes, videos and rolling, training sessions, and a ranked focus list.

How to use it well:
- Names often arrive through voice transcription and may be misspelled. Tools resolve names fuzzily; check the names they report back and correct with another call if a match looks wrong.
- When Chuck describes something he learned or noticed, call add_note with the technique names it's about. Use new_techniques only for genuinely new techniques, with your best guess at type and role.
- Before creating a technique card, use search to check whether it already exists under another name; add the alternative name as an alias.
- Model techniques as moves between positions: a sweep goes from a guard (bottom) to top; a pass goes from a guard (top) to a pin; an escape starts from a pin (bottom).
- Say where a note came from with add_note's session (a class, a seminar with its name and instructor, an open mat): "notes from today's class" is {kind: "class"}; "Zen camp seminar by Josh Jones on 2024-02-03" is {kind: "seminar", name: "Zen camp", instructor: "Josh Jones", date: "2024-02-03"}. The same session is reused, not duplicated.
- Videos and ideas he hasn't tried yet go on the To try list (add_note with to_try: true), not on a technique. He calls this "silly Instagram bullshit"; "add this to my SIB" or "something to try" means the same. Reels he shares from Instagram land there automatically. When he's tried one and likes it, file_note keeps it under the technique; get_inbox with to_try: true lists what's waiting.
- Lab is the short-term working set (get_lab): starred techniques and notes, videos to try, techniques new in his notes, questions for his coach. "Star that" or "flag that" stars whatever "that" is: a note (update_note with starred: true, or add_note with starred: true for a new one) or a technique (save_technique with starred: true). The focus list is the long-term guide: broad areas, strategies and positions over weeks or months.
- The focus list is ordered; #1 is what he's working on most. "Add X to my focus" puts it at the top unless he says otherwise.
- Replies are often read aloud, so keep confirmations short. If he says "undo that", call undo_last.`;

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });

async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] };
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD; defaults to today');
const sessionObject = z.object({
  kind: z.enum(SESSION_KINDS),
  name: z.string().optional().describe('Event name, e.g. "Zen camp"'),
  instructor: z.string().optional(),
  location: z.string().optional(),
  date: date.optional().describe("YYYY-MM-DD; defaults to the note's date"),
});
// Also accepted as JSON text: a client holding an older copy of a tool's schema sends fields it
// doesn't know about as strings.
const sessionInput = z
  .union([sessionObject, z.string()])
  .describe(
    'Where the note came from, e.g. {kind: "class"} or {kind: "seminar", name: "Zen camp", instructor: "Josh Jones", date: "2024-02-03"}. Reuses a matching session on that date.',
  );

function parseSession(v: z.infer<typeof sessionInput> | undefined): z.infer<typeof sessionObject> | undefined {
  if (typeof v !== 'string') return v;
  try {
    return sessionObject.parse(JSON.parse(v));
  } catch {
    throw new Error('session should look like {"kind": "class"} or {"kind": "seminar", "name": "Zen camp", "date": "2024-02-03"}.');
  }
}
// A yes/no option, also accepted as "true"/"false" text for the same reason as the session above.
const flag = z.union([z.boolean(), z.enum(['true', 'false'])]).transform(v => v === true || v === 'true');

const newTechnique = z.object({
  name: z.string(),
  type: z.enum(TECHNIQUE_TYPES),
  role: z.enum(ROLES).optional(),
});

export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'bjj-notes', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    'search',
    {
      title: 'Search techniques and notes',
      description:
        'Find technique cards by (fuzzy) name, alias or content, and notes by full-text search. Both also match where notes came from (an event, instructor, gym or class notes, e.g. "Zen camp", "Josh Jones"). All filters are optional; with no query it lists techniques matching the filters.',
      inputSchema: {
        query: z.string().optional(),
        type: z.enum(TECHNIQUE_TYPES).optional(),
        role: z.enum(ROLES).optional(),
        position: z.string().optional().describe('Only techniques that start or end in this position'),
        status: z.enum(STATUSES).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: readOnly,
    },
    args => run(() => search(ctx, args)),
  );

  server.registerTool(
    'get_technique',
    {
      title: 'Get a technique card',
      description: 'Full card for one technique: positions, details, mistakes, related techniques, focus status and recent notes.',
      inputSchema: { name: z.string(), note_limit: z.number().int().min(0).max(50).optional() },
      annotations: readOnly,
    },
    args => run(() => getTechnique(ctx, args.name, args.note_limit)),
  );

  server.registerTool(
    'save_technique',
    {
      title: 'Create or update a technique card',
      description:
        'Updates the card that matches name, or creates one if none matches and type is given. Lists (aliases, key_details, mistakes) are appended to unless replace_lists is true. positions adds edges in the position graph; links adds relationships to other techniques.',
      inputSchema: {
        name: z.string(),
        rename_to: z.string().optional(),
        type: z.enum(TECHNIQUE_TYPES).optional().describe('Required when creating'),
        role: z.enum(ROLES).optional(),
        gi: z.enum(GI).optional(),
        status: z.enum(STATUSES).optional(),
        summary: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        key_details: z.array(z.string()).optional(),
        mistakes: z.array(z.string()).optional(),
        replace_lists: flag.optional(),
        starred: flag.optional().describe('Star (true) or unstar (false) the technique: keep it in front of him for now (shows in Lab)'),
        positions: z
          .array(
            z.object({
              from: z.string().optional(),
              from_role: z.enum(ROLES).optional(),
              to: z.string().optional(),
              to_role: z.enum(ROLES).optional(),
            }),
          )
          .optional(),
        links: z
          .array(z.object({ kind: z.enum(LINK_KINDS), technique: z.string(), note: z.string().optional() }))
          .optional(),
      },
      annotations: write,
    },
    args => run(() => saveTechnique(ctx, args)),
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add a note',
      description:
        'Saves a dated note and links it to techniques by name. Notes whose techniques cannot be matched go to the inbox. Use session for where it came from (a class, a seminar) and source for videos (url, timestamp).',
      inputSchema: {
        text: z.string(),
        techniques: z.array(z.string()).optional(),
        new_techniques: z.array(newTechnique).optional().describe('Create these cards first (only if they do not exist)'),
        kind: z.enum(NOTE_KINDS).optional().describe('instruction = taught/watched; rolling = happened live'),
        date: date.optional().describe("YYYY-MM-DD; defaults to the session's date, else today"),
        session: sessionInput.optional(),
        to_try: flag
          .optional()
          .describe('Not tried yet ("silly Instagram bullshit"): goes on the To try list instead of being filed'),
        starred: flag.optional().describe('Star it: a recent, pertinent note to keep in front of him (shows in Lab)'),
        source: z
          .object({
            kind: z.enum(SOURCE_KINDS).optional(),
            url: z.string().optional(),
            title: z.string().optional(),
            author: z.string().optional().describe('Instructor or channel'),
            timestamp: z.string().optional().describe('Position in a video, e.g. 4:32'),
          })
          .optional(),
      },
      annotations: write,
    },
    args => run(async () => (await addNote(ctx, { ...args, session: parseSession(args.session), via: 'mcp' })).message),
  );

  server.registerTool(
    'get_inbox',
    {
      title: 'List inbox notes',
      description:
        'Notes that are not yet linked to a technique. With to_try: true, the To try list instead: videos and ideas saved to try before keeping ("silly Instagram bullshit"), newest first.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional(), to_try: flag.optional() },
      annotations: readOnly,
    },
    args => run(() => getInbox(ctx, args.limit, args.to_try === true)),
  );

  server.registerTool(
    'file_note',
    {
      title: 'File an inbox note',
      description:
        'Links an existing note to techniques and removes it from the inbox once everything is placed. For a To try note, this keeps it: it comes off the To try list.',
      inputSchema: {
        note_id: z.number().int(),
        techniques: z.array(z.string()),
        new_techniques: z.array(newTechnique).optional(),
      },
      annotations: write,
    },
    args => run(() => fileNote(ctx, args.note_id, args.techniques, args.new_techniques)),
  );

  server.registerTool(
    'update_note',
    {
      title: 'Edit a note',
      description:
        "Changes a note's text, kind, date, where it came from (session), whether it's starred or on the To try list. Leave out what shouldn't change.",
      inputSchema: {
        note_id: z.number().int(),
        text: z.string().optional(),
        kind: z.enum(NOTE_KINDS).optional(),
        date: date.optional().describe('YYYY-MM-DD'),
        session: sessionInput.optional(),
        clear_session: flag.optional().describe("True to say the note didn't come from any session"),
        to_try: flag.optional().describe('Put the note on (true) or take it off (false) the To try list'),
        starred: flag.optional().describe('Star (true) or unstar (false) the note'),
      },
      annotations: write,
    },
    args =>
      run(() =>
        updateNote(ctx, args.note_id, {
          body: args.text,
          kind: args.kind,
          observed_on: args.date,
          session: parseSession(args.session),
          session_id: args.clear_session ? null : undefined,
          to_try: args.to_try,
          starred: args.starred,
        }),
      ),
  );

  server.registerTool(
    'log_session',
    {
      title: 'Log a training session',
      description:
        'Records a class, seminar, open mat, private etc. Notes from that day without a session are attached to it. If the same kind of session is already logged that day, it is updated instead (give a different name to log a second one).',
      inputSchema: {
        date: date.optional(),
        kind: z.enum(SESSION_KINDS).optional(),
        name: z.string().optional().describe('Event name, e.g. "Zen camp"'),
        gi: z.enum(GI).optional(),
        instructor: z.string().optional(),
        location: z.string().optional(),
        summary: z.string().optional(),
      },
      annotations: write,
    },
    args => run(() => logSession(ctx, args)),
  );

  server.registerTool(
    'get_lab',
    {
      title: 'Get the Lab',
      description:
        'The short-term working set: starred techniques and notes, videos to try, techniques that are new in his notes, and open questions for his coach. Good before class.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('How far back counts as new (default 30)') },
      annotations: readOnly,
    },
    args => run(() => getLab(ctx, args.days)),
  );

  server.registerTool(
    'get_focus',
    {
      title: 'Get the focus list',
      description:
        'The ranked active focus list with how recently each item got a note, plus paused and backlog items. With history=true, returns the change log instead (optionally for one item).',
      inputSchema: { history: flag.optional(), item: z.string().optional() },
      annotations: readOnly,
    },
    args => run(() => (args.history ? focusHistory(ctx, args.item) : getFocus(ctx))),
  );

  server.registerTool(
    'update_focus',
    {
      title: 'Change the focus list',
      description:
        'add a new item (default position 1 = top), move an item to a position, resume a paused/backlog item, or pause / backlog / complete / drop one. item is the label or a linked technique name.',
      inputSchema: {
        action: z.enum(FOCUS_ACTIONS),
        item: z.string(),
        position: z.number().int().min(1).optional(),
        techniques: z.array(z.string()).optional(),
        goal: z.string().optional(),
      },
      annotations: write,
    },
    args => run(() => updateFocus(ctx, args)),
  );

  server.registerTool(
    'get_position',
    {
      title: 'Explore a position',
      description: 'Techniques available from a position (optionally as top or bottom), techniques that lead into it, and gaps.',
      inputSchema: { name: z.string(), role: z.enum(ROLES).optional() },
      annotations: readOnly,
    },
    args => run(() => getPosition(ctx, args.name, args.role)),
  );

  server.registerTool(
    'review',
    {
      title: 'Training review',
      description: 'Sessions and notes over the last N days (default 7), most-noted techniques, focus items with no recent notes, inbox size.',
      inputSchema: { days: z.number().int().min(1).max(365).optional() },
      annotations: readOnly,
    },
    args => run(() => review(ctx, args.days)),
  );

  server.registerTool(
    'undo_last',
    {
      title: 'Undo the last change',
      description: 'Reverses the most recent write (note, technique edit, focus change, session or filing).',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    () => run(() => undoLast(ctx.db)),
  );

  return server;
}
