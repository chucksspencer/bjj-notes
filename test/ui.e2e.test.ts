// Drives the built web app in Chromium at phone size. Runs when E2E=1 (CI builds the app first).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

const webDir = path.resolve('dist/public');
// The browser's clock reads in the server's zone (as on a phone in Chicago), so "Today" means the same
// day to both even when the test machine runs on UTC late in the evening.
const TIME_ZONE = 'America/Chicago';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const run = process.env.E2E === '1' && existsSync(path.join(webDir, 'index.html'));

describe.runIf(run)('web app (end to end)', () => {
  let s: TestServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    s = await startServer(null, webDir);
    browser = await chromium.launch();
    page = await (await browser.newContext({ timezoneId: TIME_ZONE, viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true })).newPage();
    page.setDefaultTimeout(8000);
  });
  afterAll(async () => {
    await browser?.close();
    await s?.close();
  });

  it('signs in', async () => {
    await page.goto(s.base);
    // Signed out, the app is black with a red bar, like its icon.
    expect(await page.evaluate(() => document.documentElement.dataset.belt ?? null)).toBeNull();
    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => page.getByRole('alert').textContent()).toBe('Wrong email or password.');
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Lab' }).waitFor(); // the Focus tab opens on the Lab
    // The app wears the owner's belt.
    expect(await page.evaluate(() => document.documentElement.dataset.belt)).toBe('purple');
    await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Focus' }).click();
    await page.getByRole('heading', { name: 'Focus' }).waitFor();
    // The heading comes before the list has loaded.
    await expect.poll(() => page.locator('.focus-row').count()).toBe(7);
  });

  it('adds a note from the tab bar and shows it on the technique card', async () => {
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByPlaceholder('What did you learn or notice?').fill('Turn to the knees before the hips.');
    await page.getByPlaceholder('Search techniques').fill('gost');
    await page.getByRole('dialog').getByRole('button', { name: /^Ghost escape/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Rolling' }).click();
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('Saved to Ghost escape').waitFor();

    await page.getByRole('link', { name: 'Ghost escape', exact: true }).click();
    await page.getByRole('heading', { name: 'Ghost escape' }).waitFor();
    await page.getByText('Turn to the knees before the hips.').waitFor();
    expect(await page.getByText('Today, rolling').count()).toBe(1);
  });

  it('sets status with the belt stripes and undoes it', async () => {
    await page.getByRole('button', { name: '2 stripes: Drilling' }).click();
    await page.locator('.belt-caption strong', { hasText: 'Drilling' }).waitFor();
    await page.getByRole('button', { name: '2 stripes: Drilling' }).click(); // tapping the top stripe takes it off
    await page.locator('.belt-caption strong', { hasText: 'Learning' }).waitFor();
  });

  it('reorders the focus list and undoes from the toast', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Focus' }).click();
    await page.getByRole('heading', { name: 'Lab' }).waitFor();
    await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Focus' }).click();
    await page.getByRole('button', { name: 'Change Ghost escape' }).click();
    await page.getByRole('button', { name: 'Top', exact: true }).click();
    await page.getByText('Moved to #1: Ghost escape').waitFor();
    expect(await page.locator('.focus-row .row-title').first().textContent()).toBe('Ghost escape');
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText(/^Undid: move/).waitFor();
    expect(await page.locator('.focus-row .row-title').first().textContent()).toBe('Baratoplata');
  });

  it('files an inbox note under a new technique', async () => {
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByPlaceholder('What did you learn or notice?').fill('Angle the shin before dropping the hip.');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('Saved to your inbox').waitFor();
    await page.getByRole('navigation').getByRole('link', { name: /Inbox/ }).click();
    await page.getByRole('button', { name: 'File under a technique' }).click();
    await page.getByPlaceholder('Search techniques').fill('Knee cut pass');
    await page.getByRole('button', { name: 'Add “Knee cut pass” as a new technique' }).click();
    await page.getByLabel('Type').selectOption('pass');
    await page.getByRole('button', { name: 'Add technique' }).click();
    await page.getByRole('button', { name: 'File note' }).click();
    await page.getByText('Filed under Knee cut pass').waitFor();
    await page.getByText('Nothing to file.').waitFor();
  });

  it('finds techniques in the library and opens a position', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click();
    await page.getByLabel('Search techniques').fill('knee cut');
    await page.getByRole('link', { name: /Knee cut pass/ }).waitFor();
    await page.getByRole('navigation').getByRole('link', { name: 'Positions' }).click();
    await page.getByRole('link', { name: /Side control/ }).first().click();
    await page.getByRole('heading', { name: 'Side control' }).waitFor();
    await page.getByText('Ghost escape').first().waitFor();
  });

  it('records where a note came from and offers it again next time', async () => {
    const sheet = page.getByRole('dialog');
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByPlaceholder('What did you learn or notice?').fill('Hide the near arm before the turn.');
    await page.getByPlaceholder('Search techniques').fill('ghost');
    await sheet.getByRole('button', { name: /^Ghost escape/ }).click();
    await sheet.getByRole('group', { name: 'From' }).getByRole('button', { name: 'New' }).click();
    await sheet.getByRole('button', { name: 'Seminar', exact: true }).click();
    await sheet.getByLabel('Event').fill('Zen camp');
    await sheet.getByLabel('Instructor').fill('Josh Jones');
    await sheet.getByText('Zen camp seminar by Josh Jones today').waitFor();
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('Saved to Ghost escape').waitFor();

    await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click();
    await page.getByLabel('Search techniques').fill('ghost');
    await page.getByRole('link', { name: /Ghost escape/ }).first().click();
    await page.getByText('From Zen camp seminar by Josh Jones').waitFor();

    // Today has exactly one session now, so a new note starts out from it.
    await page.getByRole('button', { name: 'New note' }).click();
    const chip = sheet.getByRole('group', { name: 'From' }).getByRole('button', { name: 'Zen camp seminar today' });
    await expect.poll(() => chip.getAttribute('aria-pressed')).toBe('true');
    await sheet.getByRole('group', { name: 'From' }).getByRole('button', { name: 'None' }).click();
    expect(await chip.getAttribute('aria-pressed')).toBe('false');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
  });

  it('deletes several techniques at once, and undoes it in one step', async () => {
    page.on('dialog', d => void d.accept()); // the "Delete 2 techniques?" confirmation
    await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click();
    await page.getByLabel('Search techniques').fill('');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Knee cut pass', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Baratoplata', exact: true }).check();
    await page.getByRole('toolbar', { name: 'Selection' }).getByText('2 selected').waitFor();
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByText('Deleted 2 techniques; 1 note moved to the inbox').waitFor();
    expect(await page.getByRole('link', { name: /Knee cut pass/ }).count()).toBe(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Undid: deleting 2 techniques').waitFor();
    await page.getByRole('link', { name: /Knee cut pass/ }).waitFor();
    await page.getByRole('link', { name: /Baratoplata/ }).waitFor();
  });

  it('deletes several inbox notes at once', async () => {
    for (const text of ['Stray thought one.', 'Stray thought two.']) {
      await page.getByRole('button', { name: 'New note' }).click();
      await page.getByPlaceholder('What did you learn or notice?').fill(text);
      await page.getByRole('button', { name: 'Save note' }).click();
      await page.getByText('Saved to your inbox').waitFor();
    }
    await page.getByRole('navigation').getByRole('link', { name: /Inbox/ }).click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'Select all' }).click();
    await page.getByRole('toolbar', { name: 'Selection' }).getByText('2 selected').waitFor();
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByText('Deleted 2 notes').waitFor();
    await page.getByText('Nothing to file.').waitFor();
  });

  it('puts a reel on To try, plays it only when tapped, and keeps it under a technique', async () => {
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByPlaceholder('What did you learn or notice?').fill('Lapel feed into the back take.');
    await page.getByRole('button', { name: 'Add a video or post link' }).click();
    await page.getByPlaceholder('https://youtu.be/…').fill('https://www.instagram.com/reel/DAbc123xyz/?igsh=MTc4MmM1');
    expect(await page.getByRole('checkbox', { name: /Haven't tried it yet/ }).isChecked()).toBe(true);
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('Added to To try').waitFor();

    // To try lives in the Lab, with the whole list a tap away.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Focus' }).click();
    await page.getByRole('region', { name: 'To try' }).getByText('Lapel feed into the back take.').waitFor();
    await page.getByRole('link', { name: 'See all' }).click();
    await page.getByRole('heading', { name: 'To try' }).waitFor();
    await page.getByText('Lapel feed into the back take.').waitFor();
    const open = page.getByRole('link', { name: 'Open in Instagram' });
    expect(await open.getAttribute('href')).toBe('https://www.instagram.com/reel/DAbc123xyz/');
    expect(await page.locator('iframe').count()).toBe(0); // nothing from Instagram until tapped
    await page.getByRole('button', { name: 'Play reel' }).click();
    const frame = page.locator('iframe[title="Instagram reel"]');
    await frame.waitFor({ state: 'attached' });
    expect(await frame.getAttribute('src')).toBe('https://www.instagram.com/p/DAbc123xyz/embed/captioned/');

    // Tried it, liked it: keep it under a technique.
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByPlaceholder('Search techniques').fill('ghost');
    await sheet.getByRole('button', { name: /^Ghost escape/ }).click();
    await sheet.getByRole('button', { name: 'Keep it' }).click();
    await page.getByText('Kept under Ghost escape').waitFor();
    await page.getByText('Nothing to try.', { exact: false }).waitFor();
  });

  it('tosses a video it did not like, with undo', async () => {
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByPlaceholder('What did you learn or notice?').fill('Flying armbar from standing.');
    await page.getByRole('button', { name: 'Add a video or post link' }).click();
    await page.getByPlaceholder('https://youtu.be/…').fill('https://www.instagram.com/reel/Nope999/');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('Added to To try').waitFor();
    await page.getByText('Flying armbar from standing.').waitFor();
    await page.getByRole('button', { name: 'Toss' }).click();
    await page.getByText('Tossed it').waitFor();
    await page.getByText('Nothing to try.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Flying armbar from standing.').waitFor();
  });

  it('stars techniques and notes into the Lab, triages new techniques, and answers a question for coach', async () => {
    const main = page.getByRole('navigation', { name: 'Main' });
    await main.getByRole('link', { name: 'Library' }).click();
    await page.getByLabel('Search techniques').fill('ghost');
    await page.getByRole('link', { name: /Ghost escape/ }).first().click();

    // Star the card itself, and one of its notes.
    const cardStar = page.getByRole('button', { name: 'Star Ghost escape' });
    await cardStar.click();
    await page.getByText('Starred. It’s in the Lab').waitFor();
    await expect.poll(() => cardStar.getAttribute('aria-pressed')).toBe('true');
    const note = page.getByRole('article').filter({ hasText: 'Turn to the knees before the hips.' });
    await note.getByRole('button', { name: 'Star note' }).click();
    await expect.poll(() => note.getByRole('button', { name: 'Star note' }).getAttribute('aria-pressed')).toBe('true');

    // A question, starred as it's written.
    await page.getByRole('button', { name: 'New note' }).click();
    const sheet = page.getByRole('dialog');
    await page.getByPlaceholder('What did you learn or notice?').fill('How do I stop the underhook before the ghost escape?');
    await sheet.getByRole('button', { name: 'Question' }).click();
    await sheet.getByRole('checkbox', { name: /Star it/ }).check();
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('Saved to your inbox').waitFor();

    // The Library marks starred cards.
    await main.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: /Ghost escape/ }).first().getByRole('img', { name: 'Starred' }).waitFor();

    await main.getByRole('link', { name: 'Focus' }).click();
    await page.getByRole('heading', { name: 'Lab' }).waitFor();
    const starred = page.getByRole('region', { name: 'Starred' });
    await starred.locator('.lab-tech').filter({ hasText: 'Ghost escape' }).waitFor();
    await starred.getByText('Turn to the knees before the hips.').waitFor();
    await starred.getByText('How do I stop the underhook before the ghost escape?').waitFor();

    // New techniques can be starred where they're listed.
    const fresh = page.getByRole('region', { name: 'New techniques' });
    await fresh.getByRole('link', { name: /Knee cut pass/ }).waitFor();
    await fresh.getByRole('button', { name: 'Star Knee cut pass' }).click();
    await starred.locator('.lab-tech').filter({ hasText: 'Knee cut pass' }).waitFor();

    const coach = page.getByRole('region', { name: 'Ask coach' });
    await coach.getByText('How do I stop the underhook before the ghost escape?').waitFor();
    await coach.getByRole('button', { name: 'Answered' }).click();
    await page.getByLabel('What did coach say?').fill('Frame on the hip first, then turn.');
    await page.getByRole('button', { name: 'Save answer' }).click();
    await page.getByText('Answer saved').waitFor();
    await coach.getByText('No open questions.', { exact: false }).waitFor();
    await starred.getByText(/Answer: Frame on the hip first, then turn\./).waitFor();

    // Unstar everything from the Lab; it empties out.
    const on = starred.getByRole('button', { pressed: true });
    expect(await on.count()).toBe(4);
    for (let left = 3; left >= 0; left--) {
      await on.first().click();
      await expect.poll(() => on.count()).toBe(left);
    }
    await starred.getByText('Nothing starred.', { exact: false }).waitFor();
  });

  it('folds old stars and questions away, clears them, and marks several questions answered', async () => {
    const post = (url: string, data: unknown) =>
      page.request.post(`${s.base}${url}`, { data, headers: { 'x-bjj-app': '1' } }).then(r => r.json() as Promise<{ note: { id: number } }>);
    const stale = (await post('/api/v1/notes', { text: 'An old star about frames.', starred: true })).note;
    await post('/api/v1/notes', { text: 'A star from this week.', starred: true });
    await s.db.query("update notes set starred_at = now() - interval '40 days' where id = $1", [stale.id]);
    await post('/api/v1/notes', { text: 'Old question about grips?', kind: 'question', date: '2025-03-01' });
    await post('/api/v1/notes', { text: 'Another old question about posture?', kind: 'question', date: '2025-04-01' });

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Focus' }).click();
    await page.reload(); // the notes above were made behind the app's back
    await page.getByRole('heading', { name: 'Lab' }).waitFor();
    const starred = page.getByRole('region', { name: 'Starred' });
    await starred.getByText('A star from this week.').waitFor();
    await starred.getByText('Starred today').waitFor();
    expect(await starred.getByText('An old star about frames.').count()).toBe(0); // folded away

    const olderStars = starred.getByRole('button', { name: /1 older star/ });
    await olderStars.click();
    await starred.getByText('An old star about frames.').waitFor();
    await starred.getByText('Starred a month ago', { exact: false }).or(starred.getByText(/Starred \d+ weeks ago/)).first().waitFor();
    await starred.getByRole('button', { name: 'Unstar it' }).click();
    await page.getByText('Cleared 1 star').waitFor();
    await olderStars.waitFor({ state: 'detached' });
    await starred.getByText('A star from this week.').waitFor();

    // Clear the rest.
    await page.getByRole('button', { name: 'Clear', exact: true }).click(); // confirmed by the dialog handler above
    await page.getByText(/^Cleared \d+ stars?$/).waitFor();
    await starred.getByText('Nothing starred.', { exact: false }).waitFor();

    // Old questions wait folded; select them all and mark them answered.
    const coach = page.getByRole('region', { name: 'Ask coach' });
    await coach.getByRole('button', { name: /2 older questions/ }).waitFor();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Select all' }).click();
    await page.getByRole('toolbar', { name: 'Selection' }).getByText('2 selected').waitFor();
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Mark answered' }).click();
    await page.getByText('Marked 2 questions answered').waitFor();
    await coach.getByText('No open questions.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Undo' }).click();
    await coach.getByRole('button', { name: /2 older questions/ }).waitFor();
  });

  it('shows a clip shared from Photos as its still, and says it plays in the iPhone app', async () => {
    // A 1×1 JPEG standing in for a video's still.
    const still = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
    const res = await page.request.post(`${s.base}/api/v1/capture`, {
      headers: { 'x-bjj-app': '1' },
      data: { attachments: [{ kind: 'video', thumb: still, durationS: 42, width: 1080, height: 1920, photosLocalId: 'L/1' }] },
    });
    expect(res.status()).toBe(200);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
    await page.reload();
    const clip = page.getByRole('img', { name: 'A video, 0:42 in Photos' });
    await clip.waitFor();
    await expect.poll(() => clip.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1);
    await page.getByText('Plays from Photos in the iPhone app.').waitFor();
    expect(await page.getByText('Video from Photos.').count()).toBe(0); // the placeholder text stays hidden
    await page.getByRole('button', { name: 'Select', exact: true }).click(); // tidy up (the confirm is accepted above)
    await page.getByRole('button', { name: 'Select all' }).click();
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByText('Nothing to file.').waitFor();
  });

  it('navigates on desktop Chrome 150+, where scrollTo returns a Promise', async () => {
    const ctx = await browser.newContext({ timezoneId: TIME_ZONE, viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      const scrollTo = window.scrollTo.bind(window) as (x: number, y: number) => void;
      (window as unknown as { scrollTo: (x: number, y: number) => Promise<void> }).scrollTo = (x, y) => {
        scrollTo(x, y);
        return Promise.resolve();
      };
    });
    const desktop = await ctx.newPage();
    desktop.setDefaultTimeout(8000);
    const errors: string[] = [];
    desktop.on('pageerror', e => errors.push(String(e)));
    await desktop.goto(s.base);
    await desktop.getByLabel('Password').fill(OWNER_PASSWORD);
    await desktop.getByRole('button', { name: 'Sign in' }).click();
    await desktop.getByRole('heading', { name: 'Lab' }).waitFor();
    for (const [tab, heading] of [
      ['Library', 'Library'],
      ['Positions', 'Positions'],
      ['Inbox', 'Inbox'],
      ['Focus', 'Lab'],
    ] as const) {
      await desktop.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`^${tab}`) }).click();
      await desktop.getByRole('heading', { name: heading, exact: true }).waitFor();
    }
    await desktop.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Focus' }).click();
    await desktop.getByRole('heading', { name: 'Focus', exact: true }).waitFor();
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('invites someone, who joins on their own phone with an empty notebook of their own', async () => {
    await page.goto(s.base);
    await page.getByRole('link', { name: 'Account' }).click();
    await page.getByRole('heading', { name: 'Account' }).waitFor();
    await page.getByLabel('Email (you sign in with it)').fill('owner@example.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved.').waitFor();

    await page.getByRole('button', { name: 'Invite' }).click();
    await page.getByRole('dialog').getByLabel('Their name').fill('Sam');
    await page.getByRole('dialog').getByRole('radio', { name: 'Blue belt' }).check({ force: true });
    await page.getByRole('button', { name: 'Make invite link' }).click();
    const link = await page.getByRole('dialog').getByLabel('Link').inputValue();
    expect(link).toMatch(new RegExp(`^${s.base}/join#[\\w-]{20,}$`));
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    await page.getByText('Invite for Sam').waitFor();
    await page.getByText(/^Blue belt · made today/).waitFor();

    const phone = await (await browser.newContext({ timezoneId: TIME_ZONE, viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true })).newPage();
    phone.setDefaultTimeout(8000);
    await phone.goto(link);
    await phone.getByRole('heading', { name: 'Join BJJ Notes' }).waitFor();
    expect(await phone.getByLabel('Your name').inputValue()).toBe('Sam');
    // The join page already wears their belt.
    await phone.getByText("You're joining as a blue belt").waitFor();
    expect(await phone.evaluate(() => document.documentElement.dataset.belt)).toBe('blue');
    await phone.getByLabel(/^Email/).fill('sam@example.com');
    await phone.getByLabel('Password').fill('sam-password-123');
    await phone.getByRole('button', { name: 'Create my account' }).click();
    await phone.getByRole('heading', { name: 'Lab' }).waitFor();
    expect(await phone.evaluate(() => document.documentElement.dataset.belt)).toBe('blue');
    await phone.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Library/ }).click();
    await phone.getByRole('heading', { name: 'Library', exact: true }).waitFor();
    expect(await phone.locator('.row-title', { hasText: 'Baratoplata' }).count()).toBe(0);

    // The link is spent; opening it again says so.
    await phone.goto(link);
    await phone.getByText('This link has expired or was already used.').waitFor();

    // Signing out on the phone, then in again with the new email and password.
    await phone.goto(`${s.base}/account`);
    await phone.getByRole('button', { name: 'Sign out' }).click();
    await phone.getByRole('button', { name: 'Sign in' }).waitFor();
    await phone.getByLabel('Email').fill('sam@example.com');
    await phone.getByLabel('Password').fill('sam-password-123');
    await phone.getByRole('button', { name: 'Sign in' }).click();
    await phone.getByRole('heading', { name: 'Account' }).waitFor(); // back where they were
    expect(await phone.getByLabel('Your name').count()).toBe(0);
    expect(await phone.getByLabel('Name (Claude calls you this)').inputValue()).toBe('Sam');

    // A promotion: the app changes colour as soon as the new belt is saved.
    expect(await phone.getByRole('radio', { name: 'Blue belt' }).isChecked()).toBe(true);
    await phone.getByRole('radio', { name: 'Brown belt' }).check({ force: true });
    await phone.getByText('Brown belt saved.').waitFor();
    expect(await phone.evaluate(() => document.documentElement.dataset.belt)).toBe('brown');
    const band = await phone.locator('.btn').first().evaluate(el => getComputedStyle(el).backgroundColor);
    expect(band).toBe('rgb(107, 65, 40)'); // the brown belt's colour
    await phone.context().close();

    // The owner sees Sam in People, with Sam's belt; the owner's app stays purple.
    await page.reload();
    await page.locator('.row-title', { hasText: 'Sam' }).waitFor();
    await page.getByText(/^Brown belt · sam@example.com/).waitFor();
    expect(await page.evaluate(() => document.documentElement.dataset.belt)).toBe('purple');
  });

  it('saves a reel shared from Instagram on Android, signing in first if need be', async () => {
    const android = await browser.newContext({ timezoneId: TIME_ZONE, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: ANDROID });
    const phone = await android.newPage();
    phone.setDefaultTimeout(8000);
    // What Android hands the installed web app: the link (with share-tracking) as the text.
    await phone.goto(`${s.base}/share?${new URLSearchParams({ title: 'Leg lock entry', text: 'https://www.instagram.com/reel/SHARE123/?igsh=abc' })}`);
    await phone.getByLabel('Email').fill('owner@example.com');
    await phone.getByLabel('Password').fill(OWNER_PASSWORD);
    await phone.getByRole('button', { name: 'Sign in' }).click();
    await phone.getByRole('heading', { name: 'Save to try' }).waitFor();
    await phone.getByText('Instagram reel', { exact: true }).waitFor();
    await phone.getByText('https://www.instagram.com/reel/SHARE123/', { exact: true }).waitFor();
    await phone.getByLabel("What's the takeaway? (optional)").fill('Knee line entry from single leg X');
    await phone.getByRole('button', { name: 'Save to To try' }).click();
    await phone.getByRole('heading', { name: 'To try' }).waitFor();
    await phone.getByText('Knee line entry from single leg X').waitFor();
    // The save screen is replaced, so Back leaves BJJ Notes instead of saving again.
    expect(await phone.evaluate(() => location.pathname)).toBe('/try');

    // Text shared without a link becomes a note.
    await phone.goto(`${s.base}/share?${new URLSearchParams({ text: 'Frame on the hip before shrimping' })}`);
    await phone.getByRole('heading', { name: 'Save a note' }).waitFor();
    expect(await phone.getByRole('textbox', { name: 'Note' }).inputValue()).toBe('Frame on the hip before shrimping');
    await phone.getByRole('button', { name: 'Save note' }).click();
    await phone.getByRole('heading', { name: 'Inbox' }).waitFor();
    await phone.getByText('Frame on the hip before shrimping').waitFor();

    await phone.goto(`${s.base}/share`);
    await phone.getByRole('heading', { name: 'Nothing to save' }).waitFor();

    // The Account page says how to get BJJ Notes into Android's share sheet.
    await phone.goto(`${s.base}/account`);
    await phone.getByText("Install BJJ Notes from Chrome's menu").waitFor();
    await android.close();
  });

  it('offers the shared shortcut on iPhones without the app', async () => {
    const LINK = 'https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef';
    const other = await startServer(null, webDir, { SHARE_SHORTCUT_URL: LINK });
    try {
      const signIn = async (userAgent: string) => {
        const ctx = await browser.newContext({ timezoneId: TIME_ZONE, viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent });
        const p = await ctx.newPage();
        p.setDefaultTimeout(8000);
        await p.goto(`${other.base}/account`);
        await p.getByLabel('Password').fill(OWNER_PASSWORD);
        await p.getByRole('button', { name: 'Sign in' }).click();
        await p.getByRole('heading', { name: 'Sharing videos' }).waitFor();
        return p;
      };
      const safari = await signIn(IPHONE);
      expect(await safari.getByRole('link', { name: 'Get the shortcut' }).getAttribute('href')).toBe(LINK);
      // Making a token offers the shortcut straight after, since that's what the token is for.
      await safari.getByPlaceholder("What it's for, e.g. iPhone").fill('iPhone');
      await safari.getByRole('button', { name: 'Make a token' }).click();
      await safari.getByRole('dialog').getByRole('link', { name: 'Get the shortcut' }).waitFor();
      await safari.context().close();

      // In the iPhone app, BJJ Notes is already in the share sheet: no shortcut needed.
      const app = await signIn(`${IPHONE} BJJNotesApp/1.0`);
      await app.getByText('BJJ Notes is in your share sheet').waitFor();
      expect(await app.getByRole('link', { name: 'Get the shortcut' }).count()).toBe(0);
      await app.context().close();
    } finally {
      await other.close();
    }
  });
});
