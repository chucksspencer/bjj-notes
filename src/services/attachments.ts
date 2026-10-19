// Photos and videos on notes: a reference to the original in Apple Photos, and a small still image.
import type { Queryable } from '../db.js';
import type { AttachmentView } from '../shared/api.js';
import { NotFoundError, UserError } from './errors.js';
import type { Ctx } from './context.js';

export interface AttachmentInput {
  kind: 'photo' | 'video';
  photos_local_id?: string;
  photos_cloud_id?: string;
  filename?: string;
  /** ISO 8601 */
  taken_at?: string;
  duration_s?: number;
  width?: number;
  height?: number;
  /** The still image, JPEG, base64. */
  thumb_base64: string;
}

/** A still is a small JPEG; anything much bigger than a phone-screen preview is refused. */
export const MAX_THUMB_BYTES = 400_000;

/** SQL for a note's attachments as JSON, for the note views. */
export const ATTACHMENTS_JSON = `coalesce((select json_agg(json_build_object(
    'id', a.id, 'kind', a.kind, 'photosLocalId', a.photos_local_id, 'photosCloudId', a.photos_cloud_id,
    'takenAt', to_json(a.taken_at), 'durationS', a.duration_s, 'width', a.width, 'height', a.height) order by a.id)
  from attachments a where a.note_id = n.id), '[]'::json)`;

export async function insertAttachments(q: Queryable, noteId: number, inputs: AttachmentInput[]): Promise<{ id: number; linked: boolean }[]> {
  const out: { id: number; linked: boolean }[] = [];
  for (const a of inputs) {
    const bytes = Buffer.from(a.thumb_base64, 'base64');
    if (!bytes.length) throw new UserError('A photo or video arrived without its still image.');
    if (bytes.length > MAX_THUMB_BYTES) throw new UserError('That still image is too large.');
    const { rows } = await q.query<{ id: number }>(
      `insert into attachments (note_id, kind, photos_local_id, photos_cloud_id, filename, taken_at, duration_s, width, height, thumb)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, decode($10, 'base64')) returning id`,
      [
        noteId,
        a.kind,
        a.photos_local_id ?? null,
        a.photos_cloud_id ?? null,
        a.filename ?? null,
        a.taken_at ?? null,
        a.duration_s ?? null,
        a.width ?? null,
        a.height ?? null,
        bytes.toString('base64'),
      ],
    );
    out.push({ id: rows[0]!.id, linked: !!(a.photos_local_id || a.photos_cloud_id) });
  }
  return out;
}

/** The still image, as JPEG bytes. */
export async function attachmentThumb(q: Queryable, id: number): Promise<Buffer | null> {
  const { rows } = await q.query<{ thumb: string }>(`select encode(thumb, 'base64') as thumb from attachments where id = $1`, [id]);
  return rows[0] ? Buffer.from(rows[0].thumb, 'base64') : null;
}

/** Records where the original is in Photos, once the phone has found it. */
export async function linkAttachment(ctx: Ctx, id: number, link: { photosLocalId?: string; photosCloudId?: string }): Promise<AttachmentView> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `update attachments set photos_local_id = coalesce($2, photos_local_id), photos_cloud_id = coalesce($3, photos_cloud_id)
     where id = $1 returning id`,
    [id, link.photosLocalId ?? null, link.photosCloudId ?? null],
  );
  if (!rows[0]) throw new NotFoundError(`No attachment #${id}.`);
  const view = (
    await ctx.db.query<{ v: AttachmentView | string }>(
      `select json_build_object('id', a.id, 'kind', a.kind, 'photosLocalId', a.photos_local_id, 'photosCloudId', a.photos_cloud_id,
         'takenAt', to_json(a.taken_at), 'durationS', a.duration_s, 'width', a.width, 'height', a.height) as v
       from attachments a where a.id = $1`,
      [id],
    )
  ).rows[0]!.v;
  return typeof view === 'string' ? (JSON.parse(view) as AttachmentView) : view;
}

/** "[video]", "[2 photos]", "[video, photo]": how notes with clips are marked in text for Claude. */
export function mediaTag(attachments: { kind: 'photo' | 'video' }[]): string {
  if (!attachments.length) return '';
  const videos = attachments.filter(a => a.kind === 'video').length;
  const photos = attachments.length - videos;
  const part = (n: number, noun: string) => (n === 0 ? null : n === 1 ? noun : `${n} ${noun}s`);
  return ` [${[part(videos, 'video'), part(photos, 'photo')].filter(Boolean).join(', ')} in Photos]`;
}
