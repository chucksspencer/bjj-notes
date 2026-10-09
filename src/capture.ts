import Anthropic from '@anthropic-ai/sdk';
import express, { type Router } from 'express';
import { secretsMatch } from './auth/provider.js';
import { techniquesMentionedIn } from './resolve.js';
import type { Ctx } from './services/context.js';
import { getFocus } from './services/focus.js';
import { addNote, type AddNoteInput } from './services/notes.js';
import { NOTE_KINDS, ROLES, SOURCE_KINDS, TECHNIQUE_TYPES } from './services/vocab.js';

/** What the parser extracts from a dictated note. */
export interface StructuredNote {
  note: string;
  techniques: string[];
  new_techniques: { name: string; type: (typeof TECHNIQUE_TYPES)[number]; role?: (typeof ROLES)[number] }[];
  kind: (typeof NOTE_KINDS)[number];
  source?: { kind?: (typeof SOURCE_KINDS)[number]; url?: string; title?: string; author?: string; timestamp?: string };
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
      source: {
        type: 'object',
        description: 'Only if the note mentions a video, instructor or other source.',
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

function speechFor(linked: string[], created: string[], inbox: boolean): string {
  if (!linked.length) return 'Saved to your inbox.';
  const parts = [`Saved to ${linked.join(' and ')}.`];
  if (created.length) parts.push(`New card: ${created.join(', ')}.`);
  if (inbox) parts.push("Part of it is in the inbox to file later.");
  return parts.join(' ');
}

/**
 * Plain HTTPS endpoints for Siri Shortcuts, authenticated with a static bearer token.
 *   POST /api/capture  { "text": "...", "url"?: "..." }  -> { speech, note_id }
 *   GET  /api/focus                                     -> { speech }
 */
export function captureRouter(ctx: Ctx, apiToken: string, structurer: Structurer | null): Router {
  const router = express.Router();
  router.use('/api', (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || !secretsMatch(token, apiToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.post('/api/capture', express.json({ limit: '64kb' }), async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const url = typeof req.body?.url === 'string' && req.body.url.trim() ? req.body.url.trim() : undefined;
    if (!text && !url) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    let input: AddNoteInput = { text: text || url!, raw_text: text, via: 'capture', source: url ? { url } : undefined };
    let parsed = false;
    if (structurer && text) {
      try {
        const known = {
          techniques: (await ctx.db.query<{ name: string }>('select name from techniques order by name')).rows.map(r => r.name),
          positions: (await ctx.db.query<{ name: string }>('select name from positions order by name')).rows.map(r => r.name),
        };
        const s = await structurer(text, known);
        input = {
          text: s.note?.trim() || text,
          raw_text: text,
          techniques: s.techniques ?? [],
          new_techniques: s.new_techniques ?? [],
          kind: s.kind,
          source: url ? { ...s.source, url } : s.source?.url || s.source?.author || s.source?.title ? s.source : undefined,
          via: 'capture',
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
      res.json({
        note_id: result.noteId,
        linked: result.linked,
        inbox: result.inbox,
        parsed,
        speech: speechFor(result.linked, result.created, result.inbox),
      });
    } catch (err) {
      console.error('capture: save failed', err);
      res.status(500).json({ error: 'save failed', speech: "Sorry, I couldn't save that note." });
    }
  });

  router.get('/api/focus', async (_req, res) => {
    const text = await getFocus(ctx);
    // Drop the "last note" detail for speech; keep rank and label.
    const speech = text
      .split('\n')
      .filter(l => /^\d+\. /.test(l))
      .slice(0, 5)
      .map(l => l.replace(/ — .*$/, '').replace(/ \(goal: .*\)$/, ''))
      .join('. ');
    res.json({ speech: speech ? `Your focus: ${speech}.` : 'Your focus list is empty.', text });
  });

  return router;
}
