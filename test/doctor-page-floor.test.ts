/**
 * W2.2 — absolute per-source page floor (curaition remediation, 2026-09-14).
 *
 * The plan's readback: the check reports a FAILURE against a synthetic hole.
 * Pure evaluator tests first (no engine), then the doctor check against a
 * PGLite brain: seeded pages, floors set through the real config row.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  PAGE_FLOORS_CONFIG_KEY,
  parsePageFloors,
  evaluatePageFloors,
  formatPageFloorMessage,
} from '../src/core/page-floor.ts';
import { pageFloorCheck } from '../src/commands/doctor/checks/core-health.ts';
import { BRAIN_CHECK_NAMES } from '../src/core/doctor-categories.ts';

describe('parsePageFloors', () => {
  test('unset → null (no floors), never an error', () => {
    expect(parsePageFloors(null)).toBeNull();
    expect(parsePageFloors(undefined)).toBeNull();
    expect(parsePageFloors('')).toBeNull();
  });
  test('a JSON object of source → integer floor', () => {
    expect(parsePageFloors('{"default": 4105, "curaition": "77"}')).toEqual({ default: 4105, curaition: 77 });
  });
  test('malformed values throw — a broken config must not read as "no floors"', () => {
    for (const bad of ['not json', '[1,2]', '{"default": -1}', '{"default": 1.5}', '{"default": "x"}']) {
      expect(() => parsePageFloors(bad)).toThrow(new RegExp(PAGE_FLOORS_CONFIG_KEY.replace('.', '\\.')));
    }
  });
});

describe('evaluatePageFloors — the synthetic hole', () => {
  // Hermes's measured baseline, 2026-09-14: 90% floors.
  const floors = { default: 4105, 'curaition-code': 2936, curaition: 77 };

  test('live brain passes', () => {
    const ev = evaluatePageFloors(floors, { default: 4562, 'curaition-code': 3263, curaition: 86 });
    expect(ev.status).toBe('ok');
    expect(ev.breached).toEqual([]);
    expect(ev.rows.map(r => r.verdict)).toEqual(['pass', 'pass', 'pass']);
  });

  test('curaition 86 → 6 (the incident class on the small source) FAILS', () => {
    const ev = evaluatePageFloors(floors, { default: 4562, 'curaition-code': 3263, curaition: 6 });
    expect(ev.status).toBe('fail');
    expect(ev.breached.map(r => r.source_id)).toEqual(['curaition']);
    expect(formatPageFloorMessage(ev)).toContain('curaition 6 < floor 77');
  });

  test('a floored source with NO live rows at all is a breach, not an absence', () => {
    const ev = evaluatePageFloors(floors, { default: 4562, 'curaition-code': 3263 });
    expect(ev.status).toBe('fail');
    expect(ev.breached[0]).toMatchObject({ source_id: 'curaition', live: 0, floor: 77 });
  });

  test('a live source without a floor is listed, not skipped; it does not fail the check', () => {
    const ev = evaluatePageFloors(floors, { default: 4562, 'curaition-code': 3263, curaition: 86, newsrc: 12 });
    expect(ev.status).toBe('ok');
    expect(ev.unfloored.map(r => r.source_id)).toEqual(['newsrc']);
    expect(formatPageFloorMessage(ev)).toContain('newsrc (12)');
  });

  test('sourceIds scopes the report to the caller\'s grant', () => {
    const ev = evaluatePageFloors(floors, { default: 4562, 'curaition-code': 3263, curaition: 6 }, ['default']);
    expect(ev.rows.map(r => r.source_id)).toEqual(['default']);
    expect(ev.status).toBe('ok'); // the curaition breach is outside this caller's scope
  });
});

describe('pageFloorCheck against a PGLite brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
         VALUES ('default', $1, 'note', $1, 'body', '', '{}'::jsonb)
         ON CONFLICT (source_id, slug) DO NOTHING`,
        [`floor/p${i}`],
      );
    }
  }

  test('the check name is categorised (doctor drift guard)', () => {
    expect(BRAIN_CHECK_NAMES.has('page_floor')).toBe(true);
  });

  test('no floors configured → warn, naming the live sources', async () => {
    await seed(5);
    const c = await pageFloorCheck(engine);
    expect(c.name).toBe('page_floor');
    expect(c.status).toBe('warn');
    expect(c.message).toContain('default (5)');
  });

  test('at or above floor → ok; below floor → fail (the plan\'s readback)', async () => {
    await seed(10);
    await engine.setConfig(PAGE_FLOORS_CONFIG_KEY, '{"default": 9}');
    expect((await pageFloorCheck(engine)).status).toBe('ok');
    // The synthetic hole: delete 3 of 10 → 7 < 9.
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug IN ('floor/p0','floor/p1','floor/p2')`);
    const c = await pageFloorCheck(engine);
    expect(c.status).toBe('fail');
    expect(c.message).toContain('default 7 < floor 9');
  });

  test('soft-deleted rows do not count as live', async () => {
    await seed(10);
    await engine.setConfig(PAGE_FLOORS_CONFIG_KEY, '{"default": 9}');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE source_id = 'default' AND slug IN ('floor/p0','floor/p1')`);
    expect((await pageFloorCheck(engine)).status).toBe('fail');
  });

  test('malformed config → fail, not silently unenforced', async () => {
    await seed(3);
    await engine.setConfig(PAGE_FLOORS_CONFIG_KEY, '{"default": "lots"}');
    const c = await pageFloorCheck(engine);
    expect(c.status).toBe('fail');
    expect(c.message).toContain(PAGE_FLOORS_CONFIG_KEY);
  });

  test('sourceIds scoping hides other sources from a source-bound caller', async () => {
    await seed(10);
    await engine.setConfig(PAGE_FLOORS_CONFIG_KEY, '{"default": 9, "other": 5}');
    const c = await pageFloorCheck(engine, { sourceIds: ['default'] });
    expect(c.status).toBe('ok');
    const rows = (c.details as { rows: Array<{ source_id: string }> }).rows;
    expect(rows.map(r => r.source_id)).toEqual(['default']);
  });
});
