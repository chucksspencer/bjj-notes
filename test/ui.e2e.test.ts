// Drives the built web app in Chromium at phone size. Runs when E2E=1 (CI builds the app first).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

const webDir = path.resolve('dist/public');
const run = process.env.E2E === '1' && existsSync(path.join(webDir, 'index.html'));

describe.runIf(run)('web app (end to end)', () => {
  let s: TestServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    s = await startServer(null, webDir);
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true })).newPage();
    page.setDefaultTimeout(8000);
  });
  afterAll(async () => {
    await browser?.close();
    await s?.close();
  });

  it('signs in', async () => {
    await page.goto(s.base);
    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => page.getByRole('alert').textContent()).toBe('Wrong password.');
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Focus' }).waitFor();
    expect(await page.locator('.focus-row').count()).toBe(7);
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
    await page.getByRole('navigation').getByRole('link', { name: 'Focus' }).click();
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

  it('navigates on desktop Chrome 150+, where scrollTo returns a Promise', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    await desktop.getByRole('heading', { name: 'Focus' }).waitFor();
    for (const tab of ['Library', 'Positions', 'Inbox', 'Focus']) {
      await desktop.getByRole('navigation').getByRole('link', { name: new RegExp(`^${tab}`) }).click();
      await desktop.getByRole('heading', { name: tab, exact: true }).waitFor();
    }
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
