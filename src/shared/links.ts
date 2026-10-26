// Shared by the server and the web app. Links shared into notes: keep web links only, drop share-tracking, and give each reel one address.

/** Query parameters that only record who shared a link, never what it points at. */
const TRACKING = /^(utm_\w+|igsh|igshid|fbclid|gclid|si|feature)$/i;

export interface InstagramPost {
  /** The post's shortcode, e.g. "DAbc123xyz". */
  code: string;
  /** reel, p (photo/carousel post) or tv. */
  kind: 'reel' | 'p' | 'tv';
  /** The poster's handle, when the link includes it (instagram.com/<handle>/reel/<code>). */
  handle?: string;
}

export function instagramPost(url: string): InstagramPost | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:([\w.]+)\/)?(reels?|p|tv)\/([\w-]+)/i);
  if (!m) return null;
  const kind = m[2]!.toLowerCase() === 'reels' ? 'reel' : (m[2]!.toLowerCase() as InstagramPost['kind']);
  return { code: m[3]!, kind, ...(m[1] ? { handle: m[1] } : {}) };
}

/**
 * A web link as it should be stored, or undefined if it isn't one (javascript:, garbage).
 * The same reel shared twice ("…/reel/X/?igsh=a", "…/reels/X") comes out identical.
 */
export function cleanUrl(raw: string | undefined | null): string | undefined {
  if (!raw?.trim()) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const ig = instagramPost(u.href);
  if (ig) return `https://www.instagram.com/${ig.kind}/${ig.code}/`;
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  return u.href;
}

/** The first web link in some text (e.g. what a share sheet hands over), and the text without it. */
export function splitLink(text: string): { url?: string; rest: string } {
  const m = /https?:\/\/[^\s<>"]+/i.exec(text);
  if (!m) return { rest: text.trim() };
  const url = m[0].replace(/[).,;!?]+$/, '');
  const rest = (text.slice(0, m.index) + text.slice(m.index + url.length))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return { url, rest: /^[\s.,;:!?-]*$/.test(rest) ? '' : rest };
}

/** What to call a link saved without a takeaway, so it reads sensibly on the To try list. */
export function placeholderFor(url: string): string {
  if (instagramPost(url)) return 'Instagram reel to try.';
  if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(safeHost(url))) return 'Video to try.';
  return 'Link to try.';
}

/** The text of a note that's only photos or videos, shared without a takeaway. */
export function clipPlaceholder(kinds: ('photo' | 'video')[]): string {
  const videos = kinds.filter(k => k === 'video').length;
  const photos = kinds.length - videos;
  if (kinds.length === 1) return videos ? 'Video from Photos.' : 'Photo from Photos.';
  if (!photos) return `${videos} videos from Photos.`;
  if (!videos) return `${photos} photos from Photos.`;
  return `${kinds.length} clips from Photos.`;
}

/** Whether a note's text is only a placeholder (so there's no takeaway to show or edit yet). */
export function isPlaceholder(body: string): boolean {
  const text = body.trim();
  return /^(Instagram reel|Video|Link) to (try|review)\.$/.test(text) || /^(\d+ )?(Video|Photo|Clip|video|photo|clip)s? from Photos\.$/.test(text);
}

export interface Shared {
  /** The link that was shared, tidied (share-tracking removed). */
  url?: string;
  /** Words that came with it (a caption), or the text shared when there's no link. */
  text: string;
}

/**
 * What another app shared to BJJ Notes (/share?title=…&text=…&url=…, from the web app's share target).
 * Android apps mostly put the link in "text", sometimes after a caption, and rarely use "url".
 */
export function readShare(search: string): Shared {
  const q = new URLSearchParams(search);
  const title = q.get('title')?.trim() ?? '';
  const text = q.get('text')?.trim() ?? '';
  const url = q.get('url')?.trim() ?? '';
  for (const field of [url, text, title]) {
    const found = field ? splitLink(field) : { rest: '' };
    const link = cleanUrl(found.url);
    if (link) return { url: link, text: field === text ? found.rest : '' };
  }
  return { text: [title, text].filter(Boolean).join('\n') };
}

/** "Instagram reel", "Instagram post", "YouTube video", or the site. */
export function linkKind(url: string): string {
  const ig = instagramPost(url);
  if (ig) return `Instagram ${ig.kind === 'reel' ? 'reel' : 'post'}`;
  const host = safeHost(url);
  if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(host)) return 'YouTube video';
  return host.replace(/^www\./, '') || url;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
