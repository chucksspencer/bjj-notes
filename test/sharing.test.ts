// Sharing reels and videos in without the iPhone app: the web app as an Android share target, and the
// shared "Save to BJJ Notes" shortcut offered on iPhones.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AccountView } from '../src/shared/api.js';
import { linkKind, readShare } from '../src/shared/links.js';
import { platform } from '../src/shared/platform.js';
import { API_TOKEN, OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

const share = (params: Record<string, string>) => readShare(`?${new URLSearchParams(params)}`);

describe('what another app shares', () => {
  it('finds the link wherever Android apps put it, and tidies it', () => {
    // Instagram: just the link, with share-tracking.
    expect(share({ text: 'https://www.instagram.com/reel/DAbc123/?igsh=MWx2' })).toEqual({
      url: 'https://www.instagram.com/reel/DAbc123/',
      text: '',
    });
    // YouTube: the video's title as the subject, the link as the text.
    expect(share({ title: 'Ghost escape details', text: 'https://youtu.be/dQw4w9WgXcQ?si=abc' })).toEqual({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      text: '',
    });
    // A caption before the link; and the rarely used url field.
    expect(share({ text: 'Check this out https://www.instagram.com/p/XyZ_1/ !' })).toEqual({
      url: 'https://www.instagram.com/p/XyZ_1/',
      text: 'Check this out!',
    });
    expect(share({ url: 'https://example.com/a?utm_source=x&b=1', text: 'Nice' }).url).toBe('https://example.com/a?b=1');
    // No link: the words become a note. Nothing at all: nothing to save.
    expect(share({ title: 'Idea', text: 'Frame on the hip first' })).toEqual({ text: 'Idea\nFrame on the hip first' });
    expect(share({})).toEqual({ text: '' });
    expect(share({ text: 'javascript:alert(1)' })).toEqual({ text: 'javascript:alert(1)' });
  });

  it('names what was shared', () => {
    expect(linkKind('https://www.instagram.com/reel/DAbc123/')).toBe('Instagram reel');
    expect(linkKind('https://www.instagram.com/p/DAbc123/')).toBe('Instagram post');
    expect(linkKind('https://youtu.be/dQw4w9WgXcQ')).toBe('YouTube video');
    expect(linkKind('https://www.bjjfanatics.com/x')).toBe('bjjfanatics.com');
  });

  it('tells the iPhone app, Safari on iPhone and Android apart', () => {
    const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    expect(platform(safari)).toBe('ios');
    expect(platform(`${safari.replace(' Safari/604.1', '')} BJJNotesApp/1.0`)).toBe('app');
    expect(platform('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36')).toBe(
      'android',
    );
    expect(platform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe('other');
  });

  it('registers the installed web app as a share target', () => {
    const manifest = JSON.parse(readFileSync('web/public/manifest.webmanifest', 'utf8'));
    expect(manifest.share_target).toEqual({ action: '/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } });
    // The action has to be inside the app's scope.
    expect(manifest.share_target.action.startsWith(manifest.scope)).toBe(true);
  });
});

describe('the shared iPhone shortcut', () => {
  const LINK = 'https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef';
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer(null, undefined, { SHARE_SHORTCUT_URL: LINK });
  });
  afterAll(async () => {
    await s.close();
  });

  it('only takes an iCloud shortcut link', () => {
    const base = { OWNER_PASSWORD, API_TOKEN };
    expect(loadConfig({ ...base, SHARE_SHORTCUT_URL: LINK }).shareShortcutUrl).toBe(LINK);
    expect(loadConfig(base).shareShortcutUrl).toBeUndefined();
    expect(() => loadConfig({ ...base, SHARE_SHORTCUT_URL: 'https://evil.example.com/shortcut' })).toThrow(/iCloud shortcut link/);
  });

  it('is offered on the Account page', async () => {
    const signIn = await fetch(`${s.base}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bjj-app': '1' },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const account = (await (await fetch(`${s.base}/api/v1/account`, { headers: { cookie } })).json()) as AccountView;
    expect(account.shareShortcutUrl).toBe(LINK);
  });
});
