import { describe, expect, it } from 'vitest';
import { cleanUrl, instagramPost, isPlaceholder, placeholderFor, splitLink } from '../src/shared/links.js';

describe('shared links', () => {
  it('gives every form of a reel link one address', () => {
    const canonical = 'https://www.instagram.com/reel/DAbc123xyz/';
    for (const raw of [
      'https://www.instagram.com/reel/DAbc123xyz/?igsh=MTc4MmM1YmI2Ng==',
      'https://instagram.com/reels/DAbc123xyz',
      'https://www.instagram.com/lachlan.giles/reel/DAbc123xyz/?utm_source=ig_web_copy_link',
      'https://m.instagram.com/reel/DAbc123xyz/#comments',
    ]) {
      expect(cleanUrl(raw)).toBe(canonical);
    }
    expect(cleanUrl('https://www.instagram.com/p/C9xyz_12-/?img_index=2')).toBe('https://www.instagram.com/p/C9xyz_12-/');
  });

  it('keeps the poster when the link names them', () => {
    expect(instagramPost('https://www.instagram.com/lachlan.giles/reel/DAbc123xyz/')).toEqual({
      code: 'DAbc123xyz',
      kind: 'reel',
      handle: 'lachlan.giles',
    });
    expect(instagramPost('https://www.instagram.com/reel/DAbc123xyz/')).toEqual({ code: 'DAbc123xyz', kind: 'reel' });
    expect(instagramPost('https://www.instagram.com/lachlan.giles/')).toBeNull();
    expect(instagramPost('https://www.youtube.com/watch?v=x')).toBeNull();
  });

  it('drops share-tracking but keeps what the link points at', () => {
    expect(cleanUrl('https://youtu.be/dQw4w9WgXcQ?si=AbC123&t=42')).toBe('https://youtu.be/dQw4w9WgXcQ?t=42');
    expect(cleanUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=shared&utm_campaign=x')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(cleanUrl('javascript:alert(1)')).toBeUndefined();
    expect(cleanUrl('not a link')).toBeUndefined();
    expect(cleanUrl('  ')).toBeUndefined();
  });

  it('finds the link in shared text', () => {
    expect(splitLink('Check this out https://www.instagram.com/reel/DAbc/?igsh=x.')).toEqual({
      url: 'https://www.instagram.com/reel/DAbc/?igsh=x',
      rest: 'Check this out.',
    });
    expect(splitLink('https://youtu.be/abc')).toEqual({ url: 'https://youtu.be/abc', rest: '' });
    expect(splitLink('https://youtu.be/abc.')).toEqual({ url: 'https://youtu.be/abc', rest: '' });
    expect(splitLink('no link here')).toEqual({ rest: 'no link here' });
  });

  it('names links saved without a takeaway', () => {
    expect(placeholderFor('https://www.instagram.com/reel/DAbc/')).toBe('Instagram reel to try.');
    expect(placeholderFor('https://youtu.be/abc')).toBe('Video to try.');
    expect(placeholderFor('https://example.com/article')).toBe('Link to try.');
    expect(isPlaceholder('Instagram reel to try.')).toBe(true);
    expect(isPlaceholder('Instagram reel to review.')).toBe(true); // saved before the To try list
    expect(isPlaceholder('Hide the near arm.')).toBe(false);
  });
});
