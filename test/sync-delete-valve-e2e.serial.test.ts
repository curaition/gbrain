/**
 * W2.1 delete valve — end-to-end through `performSync` (curaition remediation,
 * 2026-09-14). The pure tests in sync-delete-valve.test.ts prove the verdict;
 * this file proves the WIRING: a real temp git repo synced into PGLite, a
 * mass deletion committed, and the sync refused before its first write.
 *
 * Serial-file suffix: mutates process.env (GBRAIN_HOME, and
 * GBRAIN_ALLOW_MASS_RECONCILE in the full-sync case).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { DELETE_VALVE_ABSOLUTE_CAP } from '../src/core/sync-reconcile.ts';

let engine: PGLiteEngine;
const repos: string[] = [];
let tmpHome: string;
const originalGbrainHome = process.env.GBRAIN_HOME;
const originalAllowMass = process.env.GBRAIN_ALLOW_MASS_RECONCILE;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-w21-home-'));
  process.env.GBRAIN_HOME = tmpHome;
  delete process.env.GBRAIN_ALLOW_MASS_RECONCILE;
  await resetPgliteState(engine);
});

afterEach(() => {
  if (originalGbrainHome !== undefined) process.env.GBRAIN_HOME = originalGbrainHome;
  else delete process.env.GBRAIN_HOME;
  if (originalAllowMass !== undefined) process.env.GBRAIN_ALLOW_MASS_RECONCILE = originalAllowMass;
  else delete process.env.GBRAIN_ALLOW_MASS_RECONCILE;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-w21-'));
  repos.push(dir);
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function commitAll(dir: string, msg: string): void {
  execSync(`git add -A && git commit -m "${msg}"`, { cwd: dir, stdio: 'pipe' });
}

/** `n` tiny markdown notes under notes/. */
function notes(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`notes/n${String(i).padStart(4, '0')}.md`] = `# Note ${i}\n\nbody ${i}\n`;
  return out;
}

function removeFirst(dir: string, files: Record<string, string>, k: number): void {
  for (const rel of Object.keys(files).slice(0, k)) unlinkSync(join(dir, rel));
}

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

async function livePages(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NULL`,
  );
  return Number(rows[0].n);
}

describe('W2.1 delete valve — incremental sync', () => {
  test('a rename-wave-sized deletion is refused before any write, and the bookmark does not move', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const files = notes(30);
    const repo = mkRepo(files);
    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    expect(await livePages()).toBe(30);

    // 25 of 30 removed in one commit: 83% of the source, well over the 25% ratio.
    removeFirst(repo, files, 25);
    commitAll(repo, 'remove 25');
    const refused = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(refused.status).toBe('refused_mass_delete');
    expect(refused.deleteValve?.allowed).toBe(false);
    expect(refused.deleteValve?.reason).toBe('ratio');
    expect(refused.deleteValve?.requested).toBe(25);
    expect(refused.deleteValve?.population).toBe(30);
    expect(refused.pagesAffected).toEqual([]);
    expect(await livePages()).toBe(30);

    // Bookmark unmoved: the next plain run sees the same deletion list and refuses again.
    const again = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(again.status).toBe('refused_mass_delete');
    expect(again.deleteValve?.requested).toBe(25);
    expect(await livePages()).toBe(30);
  });

  test('--allow-deletes below the count refuses; at the count it goes through, once', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const files = notes(30);
    const repo = mkRepo(files);
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    removeFirst(repo, files, 25);
    commitAll(repo, 'remove 25');

    const tooSmall = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, allowDeletes: 10 });
    expect(tooSmall.status).toBe('refused_mass_delete');
    expect(tooSmall.deleteValve?.allowDeletes).toBe(10);
    expect(await livePages()).toBe(30);

    const allowed = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, allowDeletes: 25 });
    expect(allowed.status).toBe('synced');
    expect(allowed.deleted).toBe(25);
    expect(await livePages()).toBe(5);

    // The override was per-invocation: a later plain run is unaffected and up to date.
    const after = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(after.status).toBe('up_to_date');
    expect(await livePages()).toBe(5);
  });

  test('an ordinary small deletion passes without the flag', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const files = notes(30);
    const repo = mkRepo(files);
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    removeFirst(repo, files, 3);
    commitAll(repo, 'remove 3');
    const r = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(r.status).toBe('synced');
    expect(r.deleted).toBe(3);
    expect(r.deleteValve).toBeUndefined();
    expect(await livePages()).toBe(27);
  });

  test('the absolute cap fires even when the ratio is comfortably under 25%', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // 420 live pages; deleting 101 is 24% (under the ratio) but over the cap.
    const files = notes(420);
    const repo = mkRepo(files);
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await livePages()).toBe(420);
    removeFirst(repo, files, DELETE_VALVE_ABSOLUTE_CAP + 1);
    commitAll(repo, 'remove 101');
    const r = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(r.status).toBe('refused_mass_delete');
    expect(r.deleteValve?.reason).toBe('absolute_cap');
    expect(await livePages()).toBe(420);
  }, 60_000);
});

describe('W2.1 delete valve — full-sync reconcile', () => {
  test('the #2828 env bypass no longer suffices: reconcile deletes are skipped, the sync continues', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const files = notes(30);
    const repo = mkRepo(files);
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    removeFirst(repo, files, 25);
    commitAll(repo, 'remove 25');

    // The pre-W2.1 escape hatch: with this set, #2828 would have let a
    // reconcile sweep 25 of 30 file-backed pages. The W2.1 valve has no
    // environment override, so the deletes are still skipped.
    process.env.GBRAIN_ALLOW_MASS_RECONCILE = '1';
    const r = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(r.deleted).toBe(0);
    expect(r.deleteValve?.allowed).toBe(false);
    expect(r.deleteValve?.requested).toBe(25);
    expect(await livePages()).toBe(30);

    // The count, stated, lets the same full sync reconcile.
    const ok = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true, allowDeletes: 25 });
    expect(ok.deleted).toBe(25);
    expect(ok.deleteValve?.overridden).toBe(true);
    expect(await livePages()).toBe(5);
  });
});

describe('W2.4 honest delete counter — rows actually removed, on every route', () => {
  test('a diff that lists 3 deletions but only 2 rows exist reports 2, and says so in ingest_log', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const files = notes(30);
    const repo = mkRepo(files);
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // One page vanishes out of band (an MCP delete, a purge) — the diff will
    // still list its file when the file is removed, but there is no row to
    // delete. The pre-W2.4 summary would have reported the diff's 3.
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = 'notes/n0000'`);
    expect(await livePages()).toBe(29);
    removeFirst(repo, files, 3);
    commitAll(repo, 'remove 3');
    const r = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(r.status).toBe('synced');
    expect(r.deleted).toBe(3);      // what the diff listed
    expect(r.deletedRows).toBe(2);  // what actually happened
    expect(await livePages()).toBe(27);
    const log = await engine.executeRaw<{ summary: string }>(
      `SELECT summary FROM ingest_log WHERE source_type = 'git_sync' ORDER BY id DESC LIMIT 1`,
    );
    expect(log[0].summary).toContain('-2');
    expect(log[0].summary).toContain('(diff listed 3 deletions)');
  });

  test('the reported number equals the real change in the live count', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const files = notes(30);
    const repo = mkRepo(files);
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await livePages();
    removeFirst(repo, files, 4);
    commitAll(repo, 'remove 4');
    const r = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(r.deletedRows).toBe(before - (await livePages()));
    const log = await engine.executeRaw<{ summary: string }>(
      `SELECT summary FROM ingest_log WHERE source_type = 'git_sync' ORDER BY id DESC LIMIT 1`,
    );
    expect(log[0].summary).toContain('-4 ');
    expect(log[0].summary).not.toContain('diff listed');
  });

  test('a refused run reports zero rows removed', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const files = notes(30);
    const repo = mkRepo(files);
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    removeFirst(repo, files, 25);
    commitAll(repo, 'remove 25');
    const r = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(r.status).toBe('refused_mass_delete');
    expect(r.deletedRows).toBe(0);
  });
});
