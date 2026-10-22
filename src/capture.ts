import Anthropic from '@anthropic-ai/sdk';
import express, { type Router } from 'express';
import { userForApiToken } from './auth/users.js';
import { uid } from './db.js';
import { userIdOf } from './http/auth.js';
import { clipPlaceholder, placeholderFor, splitLink } from './shared/links.js';
import { MAX_THUMB_BYTES, type AttachmentInput } from './services/attachments.js';
import { techniquesMentionedIn } from './resolve.js';
import { userCtx, type Ctx } from './services/context.js';
import { getFocus } from './services/focus.js';
import { addNote, type AddNoteInput } from './services/notes.js';
import { NOTE_KINDS, ROLES, SESSION_KINDS, SOURCE_KINDS, TECHNIQUE_TYPES } from './services/vocab.js';

/** What the parser extracts from a dictated note. */
export interface StructuredNote {
  note: string;
  techniques: string[];
  new_techniques: { name: string; type: (typeof TECHNIQUE_TYPES)[number]; role?: (typeof ROLES)[number] }[];
  kind: (typeof NOTE_KINDS)[number];
  source?: { kind?: (typeof SOURCE_KINDS)[number]; url?: string; title?: string; author?: string; timestamp?: string };
  session?: { kind: (typeof SESSION_KINDS)[number]; name?: string; instructor?: string; date?: string };
}

export type Structurer = (text: string, known: { techniques: string[]; positions: string[] }) => Promise<StructuredNote>;

const FILE_NOTE_TOOL = {
  name: 'file_note',
  description: 'File a dictated BJJ training note.',
  input_schema: {
    type: 'object' as const,
    properties: {
      note: {
        type: 'string',
        description:
          "The note, cleaned of filler words and transcription errors, in the speaker's own voice. Keep every technical detail.",
      },
      techniques: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names from the known technique list that this note is about, spelled exactly as listed.',
      },
      new_techniques: {
        type: 'array',
        description: 'Techniques clearly named in the note that are not in the known list. Leave empty when unsure.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: [...TECHNIQUE_TYPES] },
            role: { type: 'string', enum: [...ROLES] },
          },
          required: ['name', 'type'],
        },
      },
      kind: {
        type: 'string',
        enum: [...NOTE_KINDS],
        description: 'instruction = taught in class or watched; rolling = happened while sparring; drilling; question; idea.',
      },
      session: {
        type: 'object',
        description:
          'Only if the note says where it was taught or happened: a class, a seminar (with its event name and instructor), an open mat, a private lesson.',
        properties: {
          kind: { type: 'string', enum: [...SESSION_KINDS] },
          name: { type: 'string', description: 'Event name, e.g. "Zen camp"' },
          instructor: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD, only if the note states the date' },
        },
        required: ['kind'],
      },
      source: {
        type: 'object',
        description: 'Only if the note mentions a video, book or other media it came from.',
        properties: {
          kind: { type: 'string', enum: [...SOURCE_KINDS] },
          url: { type: 'string' },
          title: { type: 'string' },
          author: { type: 'string' },
          timestamp: { type: 'string' },
        },
      },
    },
    required: ['note', 'techniques', 'new_techniques', 'kind'],
  },
};

/** Uses Claude to turn a dictated note into structured fields. */
export function claudeStructurer(apiKey: string, model: string): Structurer {
  const client = new Anthropic({ apiKey });
  return async (text, known) => {
    const msg = await client.messages.create({
      model,
      max_tokens: 1024,
      system:
        'You file Brazilian jiu-jitsu training notes that were dictated by voice, so technique names may be misheard ' +
        '(e.g. "barra toe plata" means Baratoplata). Map mentions to the known techniques where they clearly match.\n\n' +
        `Known techniques: ${known.techniques.join('; ') || '(none yet)'}\n` +
        `Known positions: ${known.positions.join('; ')}`,
      tools: [FILE_NOTE_TOOL],
      tool_choice: { type: 'tool', name: 'file_note' },
      messages: [{ role: 'user', content: text }],
    });
    const block = msg.content.find(b => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('Parser returned no structured note');
    return block.input as StructuredNote;
  };
}

/** Drops a date the parser made up in the wrong shape rather than failing the save. */
function cleanSession(s: NonNullable<StructuredNote['session']>): NonNullable<StructuredNote['session']> {
  return { ...s, date: s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : undefined };
}

function speechFor(linked: string[], created: string[], inbox: boolean): string {
  if (!linked.length) return 'Saved to your inbox.';
  const parts = [`Saved to ${linked.join(' and ')}.`];
  if (created.length) parts.push(`New card: ${created.join(', ')}.`);
  if (inbox) parts.push("Part of it is in the inbox to file later.");
  return parts.join(' ');
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_ID = /^[\w-]{8,64}$/;

/**
 * Photos and videos sent with a note: [{ kind, thumb (JPEG, base64), photosLocalId?, photosCloudId?,
 * filename?, takenAt?, durationS?, width?, height? }]. Malformed entries are skipped.
 */
function parseAttachments(raw: unknown): AttachmentInput[] | 'too big' | 'not jpeg' {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const int = (v: unknown) => (num(v) === undefined ? undefined : Math.round(v as number));
  const out: AttachmentInput[] = [];
  for (const item of raw.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if ((a.kind !== 'photo' && a.kind !== 'video') || typeof a.thumb !== 'string' || !a.thumb) continue;
    if (a.thumb.length > Math.ceil((MAX_THUMB_BYTES * 4) / 3) + 4) return 'too big';
    const head = Buffer.from(a.thumb.slice(0, 8), 'base64');
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return 'not jpeg';
    const takenAt = str(a.takenAt, 40);
    out.push({
      kind: a.kind,
      thumb_base64: a.thumb,
      photos_local_id: str(a.photosLocalId, 300),
      photos_cloud_id: str(a.photosCloudId, 600),
      filename: str(a.filename, 255),
      taken_at: takenAt && !Number.isNaN(Date.parse(takenAt)) ? takenAt : undefined,
      duration_s: num(a.durationS),
      width: int(a.width),
      height: int(a.height),
    });
  }
  return out;
}

/**
 * Saves a dictated or shared note: tidied and linked to techniques by the parser when there is one.
 * Optional hints from the caller win over the parser: `kind` ("question" for Ask coach), `starred`,
 * `date` (the day it was captured, for notes that waited offline), and `clientId` (a retry with the
 * same id returns the first save instead of saving twice).
 */
export async function captureNote(
  ctx: Ctx,
  structurer: Structurer | null,
  body: Record<string, unknown> | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const b = body ?? {};
  let text = typeof b.text === 'string' ? b.text.trim() : '';
  let url: string | undefined;
  // A share sheet may hand over a bare link or text with the link inside (a caption and a URL);
  // a dictated note may contain one too. Either way the link becomes the note's source.
  for (const candidate of [b.url, text]) {
    if (url || typeof candidate !== 'string') continue;
    const found = splitLink(candidate);
    if (!found.url) continue;
    url = found.url;
    if (candidate === text) text = found.rest;
  }
  const attachments = parseAttachments(b.attachments);
  if (attachments === 'too big') {
    return { status: 400, body: { error: 'still too large', speech: "That photo's preview was too large to save." } };
  }
  if (attachments === 'not jpeg') {
    return { status: 400, body: { error: 'still not a jpeg', speech: "That photo's preview couldn't be read." } };
  }
  if (!text && !url && !attachments.length) {
    return { status: 400, body: { error: 'text is required', speech: 'Nothing to save. Say a takeaway or share a link.' } };
  }
  const kindHint = NOTE_KINDS.find(k => k === b.kind);
  const date = typeof b.date === 'string' && DATE.test(b.date) ? b.date : undefined;
  const clientId = typeof b.clientId === 'string' && CLIENT_ID.test(b.clientId) ? b.clientId : undefined;
  const starred = b.starred === true;
  // Anything shared with a link is something to try out before it earns a place in the library.
  const toTry = !!url && kindHint !== 'question';
  const hints = {
    date,
    client_id: clientId,
    starred,
    ...(kindHint ? { kind: kindHint } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
  let input: AddNoteInput = {
    text: text || (url ? placeholderFor(url) : clipPlaceholder(attachments.map(a => a.kind))),
    raw_text: text,
    via: 'capture',
    source: url ? { url } : undefined,
    to_try: toTry,
    ...hints,
  };
  let parsed = false;
  if (structurer && text) {
    try {
      const known = {
        techniques: (
          await ctx.db.query<{ name: string }>('select name from techniques where user_id = $1 order by name', [uid(ctx.db)])
        ).rows.map(r => r.name),
        positions: (await ctx.db.query<{ name: string }>('select name from positions order by name')).rows.map(r => r.name),
      };
      const s = await structurer(text, known);
      input = {
        text: s.note?.trim() || text,
        raw_text: text,
        techniques: s.techniques ?? [],
        new_techniques: s.new_techniques ?? [],
        kind: s.kind,
        to_try: toTry,
        session: s.session?.kind && SESSION_KINDS.includes(s.session.kind) ? cleanSession(s.session) : undefined,
        source: url ? { ...s.source, url } : s.source?.url || s.source?.author || s.source?.title ? s.source : undefined,
        via: 'capture',
        ...hints,
      };
      parsed = true;
    } catch (err) {
      console.error('capture: parser failed, saving raw note', err);
    }
  }
  if (!parsed && text) {
    // No parser (or it failed): still link any technique named word-for-word in the text.
    input.techniques = (await techniquesMentionedIn(ctx.db, text)).map(t => t.name);
  }
  try {
    const result = await addNote(ctx, input);
    const about = result.linked.length ? `, about ${result.linked.join(' and ')}` : '';
    const speech = result.duplicate
      ? 'Already saved.'
      : input.kind === 'question'
        ? `Added to Ask coach${about}.`
        : result.toTry
          ? `Added to your to-try list${about}.`
          : speechFor(result.linked, result.created, result.inbox);
    return {
      status: 200,
      body: {
        note_id: result.noteId,
        linked: result.linked,
        inbox: result.inbox,
        parsed,
        to_try: result.toTry,
        duplicate: result.duplicate === true,
        attachments: result.attachments ?? [],
        speech: starred && !result.duplicate ? `${speech.replace(/\.$/, '')}, starred.` : speech,
      },
    };
  } catch (err) {
    console.error('capture: save failed', err);
    return { status: 500, body: { error: 'save failed', speech: "Sorry, I couldn't save that note." } };
  }
}

/** The same capture for the iPhone app, signed in like the web app (session cookie) or with an API token. */
export function appCaptureRouter(base: Ctx, structurer: Structurer | null, requireAuth: express.RequestHandler): Router {
  const router = express.Router();
  // Room for a note's still images (each a small JPEG).
  router.post('/api/v1/capture', express.json({ limit: '6mb' }), requireAuth, async (req, res) => {
    const out = await captureNote(userCtx(base, userIdOf(res)), structurer, req.body);
    res.status(out.status).json(out.body);
  });
  return router;
}

/**
 * Plain HTTPS endpoints for Siri Shortcuts, authenticated with a bearer token: the owner's API_TOKEN,
 * or a token someone made on their Account page. Each token reads and writes its own person's notebook.
 *   POST /api/capture  { "text": "...", "url"?: "..." }  -> { speech, note_id }
 *   GET  /api/focus                                     -> { speech }
 */
export function captureRouter(base: Ctx, apiToken: string, structurer: Structurer | null): Router {
  const router = express.Router();
  // The token goes in the Authorization header, or (for POSTs) as a "token" field in the JSON body:
  // headers are fiddly to set in the Shortcuts app, and a body field isn't written to request logs.
  const auth: express.RequestHandler = async (req, res, next) => {
    try {
      const header = req.get('authorization') ?? '';
      const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      const token = header.replace(/^Bearer\s+/i, '').trim() || bodyToken;
      const userId = token ? await userForApiToken(base.db, token, apiToken) : null;
      if (userId === null) {
        res.status(401).json({
          error: 'unauthorized',
          speech: token ? "BJJ Notes didn't accept that token. Check the token in the shortcut." : 'The shortcut sent no token.',
        });
        return;
      }
      res.locals.userId = userId;
      next();
    } catch (err) {
      next(err);
    }
  };

  router.post('/api/capture', express.json({ limit: '64kb' }), auth, async (req, res) => {
    const out = await captureNote(userCtx(base, userIdOf(res)), structurer, req.body);
    res.status(out.status).json(out.body);
  });

  router.get('/api/focus', auth, async (_req, res) => {
    const text = await getFocus(userCtx(base, userIdOf(res)));
    // Drop the "last note" detail for speech; keep rank and label.
    const speech = text
      .split('\n')
      .filter(l => /^\d+\. /.test(l))
      .slice(0, 5)
      .map(l => l.replace(/ — .*$/, '').replace(/ \(goal: .*\)$/, ''))
      .join('. ');
    res.json({ speech: speech ? `Your focus: ${speech}.` : 'Your focus list is empty.', text });
  });

  // Shortcuts show "speech", so even a body that isn't JSON gets a readable answer.
  router.use(((err, _req, res, next) => {
    if ((err as { type?: string }).type !== 'entity.parse.failed') return next(err);
    res.status(400).json({ error: 'invalid JSON', speech: "BJJ Notes couldn't read what the shortcut sent. Check the request body is JSON." });
  }) as express.ErrorRequestHandler);

  return router;
}
