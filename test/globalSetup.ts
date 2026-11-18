// Once per test run: two embedded databases on disk, one new and one with every migration applied. Each test file's
// database starts as a copy of one of them (a quarter of a second) instead of a new embedded Postgres and the
// migrations (two to three seconds). Real Postgres (TEST_PG_ADMIN_URL) doesn't need this: a new database there is quick.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { migrate, pgliteDb } from '../src/db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The folder holding `empty/` and `migrated/` (see freshDb in helpers.ts); empty when on real Postgres. */
    pgliteTemplates: string;
  }
}

let dir = '';

export async function setup(project: TestProject) {
  if (!process.env.TEST_PG_ADMIN_URL) {
    dir = mkdtempSync(path.join(tmpdir(), 'bjj-test-'));
    const empty = await pgliteDb(path.join(dir, 'empty'));
    await empty.close();
    cpSync(path.join(dir, 'empty'), path.join(dir, 'migrated'), { recursive: true });
    const migrated = await pgliteDb(path.join(dir, 'migrated'));
    await migrate(migrated);
    await migrated.close();
  }
  project.provide('pgliteTemplates', dir);
}

export function teardown() {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
