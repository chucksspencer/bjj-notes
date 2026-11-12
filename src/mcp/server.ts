import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { undoLast } from '../services/activity.js';
import type { Ctx } from '../services/context.js';
import { getLab, getPosition, review, search } from '../services/explore.js';
import { deleteArea, focusHistory, getArea, getFocus, listAreas, MAX_DEPTH, MAX_STEPS, saveArea, updateFocus } from '../services/areas.js';
import { clearStars } from '../services/marks.js';
import { addNote, fileNote, getInbox, updateNote } from '../services/notes.js';
import { logSession } from '../services/sessions.js';
import { getTechnique, saveTechnique } from '../services/techniques.js';
import {
  FOCUS_ACTIONS,
  GI,
  LINK_KINDS,
  NOTE_KINDS,
  OLD_FOCUS_ACTIONS,
  ROLES,
  SESSION_KINDS,
  SOURCE_KINDS,
  STATUSES,
  TECHNIQUE_TYPES,
} from '../services/vocab.js';

/** What Claude is told about the notebook, written for the person it belongs to. */
export function instructions(name: string | null, belt?: string): string {
  const who = name?.trim() || 'the user';
  const rank = belt ? ` ${name?.trim() ? who : 'They'} ${name?.trim() ? 'is' : 'are'} a ${belt} belt.` : '';
  return `${name?.trim() ? `${who}'s` : 'A'} personal Brazilian jiu-jitsu notebook: technique cards organised as a position graph, dated notes from classes, videos and rolling, training sessions, areas of the game (some with a plan), and a ranked focus list.${rank}

How to use it well:
- Names often arrive through voice transcription and may be misspelled. Tools resolve names fuzzily; check the names they report back and correct with another call if a match looks wrong.
- When ${who} describes something learned or noticed, call add_note with the technique names it's about. Use new_techniques only for genuinely new techniques, with your best guess at type and role.
- Before creating a technique card, use search to check whether it already exists under another name; add the alternative name as an alias.
- Model techniques as moves between positions: a sweep goes from a guard (bottom) to top; a pass goes from a guard (top) to a pin; an escape starts from a pin (bottom).
- Say where a note came from with add_note's session (a class, a seminar with its name and instructor, an open mat): "notes from today's class" is {kind: "class"}; "Zen camp seminar by Josh Jones on 2024-02-03" is {kind: "seminar", name: "Zen camp", instructor: "Josh Jones", date: "2024-02-03"}. The same session is reused, not duplicated.
- Videos and ideas not tried yet go on the To try list (add_note with to_try: true), not on a technique. It's also called "silly Instagram bullshit"; "add this to my SIB" or "something to try" means the same. Reels shared from Instagram land there automatically. Once one has been tried and is worth keeping, file_note keeps it under the technique; get_inbox with to_try: true lists what's waiting.
- Lab is the short-term working set (get_lab): starred techniques and notes, videos to try, techniques new in the notes, questions for the coach. "Star that" or "flag that" stars whatever "that" is: a note (update_note with starred: true, or add_note with starred: true for a new one) or a technique (save_technique with starred: true). Stars are for what's pertinent now: after 4 weeks they fold away as older stars, and clear_stars unstars old ones (or all). When the coach answers a question, update_note with answered: true and add the answer to the text. The focus list is the long-term guide, over weeks or months.
- An area is a part of ${who}'s game: a name, a description (the strategy, cues, what success looks like), techniques and notes. It can have a plan: where it starts, then a main line of steps with branches for how the opponent reacts ("if they post the far leg, go to deep half"). "System" and "game plan" mean an area with a plan. When ${who} describes one, call save_area with the steps as an outline; get_area reads one back (or lists them all).
- The focus list is the areas being worked on now, in order; #1 is worked on most. "Add X to my focus" is update_focus add, which puts it at the top unless told otherwise, and makes the area if there isn't one. "I'm done with X for now" or "take X off my focus" is update_focus remove: the area and its plan stay.
- "Add a note to my X focus" or "file that under X" is add_note with area: X (and the techniques it's about).
- Replies are often read aloud, so keep confirmations short. "Undo that" means undo_last.`;
}

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

export function buildMcpServer(ctx: Ctx, user: { name: string | null; belt?: string } = { name: null }): McpServer {
  const server = new McpServer({ name: 'bjj-notes', version: '0.1.0' }, { instructions: instructions(user.name, user.belt) });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    'search',
    {
      title: 'Search techniques and notes',
      description:
        'Find technique cards by (fuzzy) name, alias or content, and notes by full-text search. Both also match where notes came from (an event, instructor, gym or class notes, e.g. "Zen camp", "Josh Jones"). ' +
        (ctx.rewriter
          ? 'Queries also match by meaning, so a question in plain words ("how do I stop the knee cut") finds notes and cards about it that use other words. '
          : '') +
        'All filters are optional; with no query it lists techniques matching the filters.',
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
      description: 'Full card for one technique: positions, details, mistakes, related techniques, the areas it is part of and recent notes.',
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
        area: z.string().optional().describe('An area (or focus item) to file the note under, by its name or a linked technique'),
        focus: z.string().optional().describe('Older name for area'),
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
    args =>
      run(async () => {
        const { focus, area, ...rest } = args;
        return (await addNote(ctx, { ...rest, area: area ?? focus, session: parseSession(args.session), via: 'mcp' })).message;
      }),
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
        "Changes a note's text, kind, date, where it came from (session), whether it's starred, on the To try list, or (for a question) answered. Leave out what shouldn't change.",
      inputSchema: {
        note_id: z.number().int(),
        text: z.string().optional(),
        kind: z.enum(NOTE_KINDS).optional(),
        date: date.optional().describe('YYYY-MM-DD'),
        session: sessionInput.optional(),
        clear_session: flag.optional().describe("True to say the note didn't come from any session"),
        to_try: flag.optional().describe('Put the note on (true) or take it off (false) the To try list'),
        starred: flag.optional().describe('Star (true) or unstar (false) the note'),
        answered: flag.optional().describe('Mark a question answered (true; it leaves Ask coach) or open again (false)'),
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
          answered: args.answered,
        }),
      ),
  );

  server.registerTool(
    'clear_stars',
    {
      title: 'Clear stars',
      description:
        'Unstars techniques and notes in one step: those starred more than older_than_days days ago, or every star when it is left out. undo_last puts them all back.',
      inputSchema: { older_than_days: z.number().int().min(1).max(3650).optional() },
      annotations: write,
    },
    args => run(() => clearStars(ctx, args.older_than_days)),
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
        'The ranked focus list: the areas being worked on now, with how recently each got a note. With history=true, the log of what went on and off the list and when (optionally for one item). To read one area, use get_area.',
      inputSchema: { history: flag.optional(), item: z.string().optional().describe('With history: one area') },
      annotations: readOnly,
    },
    args => run(() => (args.history ? focusHistory(ctx, args.item) : args.item ? getArea(ctx, args.item) : getFocus(ctx))),
  );

  server.registerTool(
    'update_focus',
    {
      title: 'Change the focus list',
      description:
        'add puts an area on the focus list (default position 1 = top), making the area if none matches; move re-ranks one; remove takes one off (the area, its plan and notes stay). item is the area name or a linked technique name. resume, pause, backlog, complete and drop are older names: resume = add, the rest = remove.',
      inputSchema: {
        action: z.enum([...FOCUS_ACTIONS, ...OLD_FOCUS_ACTIONS]),
        item: z.string(),
        position: z.number().int().min(1).optional(),
        techniques: z.array(z.string()).optional().describe('Techniques to link to the area'),
        description: z.string().optional().describe('When add makes a new area: what it is about'),
        notes: z.array(z.number().int()).optional().describe('Note ids to file under the area'),
      },
      annotations: write,
    },
    args => run(() => updateFocus(ctx, { ...args, note_ids: args.notes })),
  );

  server.registerTool(
    'get_area',
    {
      title: 'Get an area',
      description:
        'With name: one area, on focus or not: where its plan starts, each step and branch read as if/then with its technique status and what it hands off to, its techniques and notes. Without name: every area, grouped by where its plan starts.',
      inputSchema: { name: z.string().optional().describe('Area name, alias or a linked technique') },
      annotations: readOnly,
    },
    args => run(() => (args.name?.trim() ? getArea(ctx, args.name) : listAreas(ctx))),
  );

  // Flat, with a depth on each step: clients holding a simplified copy of a tool's schema handle that
  // better than nested steps.
  const step = z.object({
    depth: z.number().int().min(0).max(MAX_DEPTH).describe('0 = main line; 1 = a branch off the nearest step above it at depth 0; and so on'),
    when: z.string().optional().describe('The reaction that leads here, e.g. "they post the far leg". Leave out for "then".'),
    do: z.string().describe('What to do, as said: a technique, a family of moves ("octopus sweeps") or "go to deep half"'),
    technique: z.string().optional().describe('The technique card to link, if "do" is not its name'),
    to: z.string().optional().describe('The position it leaves you in, e.g. "deep half"'),
    to_role: z.enum(ROLES).optional(),
    note: z.string().optional().describe('The intent or a cue, e.g. "force them to post the underhook hand"'),
  });

  server.registerTool(
    'save_area',
    {
      title: 'Create or change an area',
      description:
        'An area is a part of the game; with a plan it is a system. Changes the area that matches name (or a linked technique), or makes one. steps, when given, replaces the whole plan, in reading order: to change one branch, get_area first and send the full outline back. focus: true puts it on the focus list (at position, default the top); false takes it off. delete: true removes the area for good (its notes and techniques stay). Leave out what should not change.',
      inputSchema: {
        name: z.string(),
        rename_to: z.string().optional(),
        aliases: z.array(z.string()).optional().describe('Other names it goes by (replaces the list)'),
        description: z.string().optional().describe('Replaces the description; an empty string clears it'),
        techniques: z.array(z.string()).optional().describe('Techniques to link'),
        start: z.string().optional().describe('Where the plan starts, e.g. "half guard"; an empty string clears it'),
        start_role: z.enum(ROLES).optional(),
        premise: z.string().optional().describe('The situation it is for, e.g. "top has the underhook and crossface"'),
        steps: z.array(step).max(MAX_STEPS).optional(),
        focus: flag.optional(),
        position: z.number().int().min(1).optional(),
        delete: flag.optional(),
      },
      annotations: write,
    },
    args =>
      run(() => {
        const { delete: del, ...rest } = args;
        return del ? deleteArea(ctx, { name: args.name }) : saveArea(ctx, rest);
      }),
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
      description: 'Sessions and notes over the last N days (default 7), most-noted techniques, focus areas with no recent notes, inbox size.',
      inputSchema: { days: z.number().int().min(1).max(365).optional() },
      annotations: readOnly,
    },
    args => run(() => review(ctx, args.days)),
  );

  server.registerTool(
    'undo_last',
    {
      title: 'Undo the last change',
      description: 'Reverses the most recent write (note, technique edit, area or focus change, session or filing).',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    () => run(() => undoLast(ctx.db)),
  );

  return server;
}
