/**
 * Test: the W2.1 delete valve — one gate in front of EVERY bulk delete path.
 *
 * Regression cover for the 2026-09-11 incident (1,139 code pages destroyed by
 * a rename wave read as deletions). The existing #2828 valve did not fire:
 * it guards only the full-sync reconcile, and it divides by the file-backed
 * population, which a code source no longer has after the W1.2 split.
 *
 * Pure-helper surface: counts in, verdict out. No engine, no git, no env.
 */

import { describe, test, expect } from 'bun:test';
import {
  evaluateDeleteValve,
  parseAllowDeletes,
  formatDeleteValveRefusal,
  DELETE_VALVE_ABSOLUTE_CAP,
  DELETE_VALVE_RATIO,
  DELETE_VALVE_MIN_POPULATION,
} from '../src/core/sync-reconcile.ts';

describe('evaluateDeleteValve — the 2026-09-11 incident replayed', () => {
  // Measured on the incident's own data: the run wanted 1,160 deletions
  // (1,109 renamed-away + 50 genuine + 1 residual) against a source of
  // ~4,488 live pages (3,349 survivors + 1,139 destroyed).
  const population = 4_488;

  test('the incident delete set is refused', () => {
    const v = evaluateDeleteValve({ requested: 1_160, population });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('absolute_cap');
    expect(v.overridden).toBe(false);
  });

  test('the 50 genuine deletions in the same range pass', () => {
    const v = evaluateDeleteValve({ requested: 50, population });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBeNull();
  });

  test('the incident set is refused by the ratio alone, even with a cap wide enough', () => {
    // 1,160 / 4,488 = 25.8% — above the 25% ratio independently of the cap.
    expect(1_160 / population).toBeGreaterThan(DELETE_VALVE_RATIO);
    // Show the ratio rule on its own: a request under the cap but over the ratio.
    const v = evaluateDeleteValve({ requested: DELETE_VALVE_ABSOLUTE_CAP, population: 300 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('ratio');
  });
});

describe('evaluateDeleteValve — limits', () => {
  test('zero requested is always allowed, whatever the population', () => {
    expect(evaluateDeleteValve({ requested: 0, population: 0 }).allowed).toBe(true);
    expect(evaluateDeleteValve({ requested: 0, population: 10_000 }).allowed).toBe(true);
  });

  test('absolute cap: one over refuses regardless of population size', () => {
    const under = evaluateDeleteValve({ requested: DELETE_VALVE_ABSOLUTE_CAP, population: 1_000_000 });
    const over = evaluateDeleteValve({ requested: DELETE_VALVE_ABSOLUTE_CAP + 1, population: 1_000_000 });
    expect(under.allowed).toBe(true);
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe('absolute_cap');
  });

  test('ratio: the curaition docs source (86 live pages)', () => {
    // 86 × 0.25 = 21.5 → 21 passes, 22 refuses.
    expect(evaluateDeleteValve({ requested: 21, population: 86 }).allowed).toBe(true);
    const v = evaluateDeleteValve({ requested: 22, population: 86 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('ratio');
  });

  test('small sources are judged by the cap only, not the ratio', () => {
    // 15 of 18 is 83%, but the population is at or below the minimum.
    const v = evaluateDeleteValve({ requested: 15, population: DELETE_VALVE_MIN_POPULATION - 2 });
    expect(v.allowed).toBe(true);
    // One page above the minimum population and the ratio applies.
    const w = evaluateDeleteValve({ requested: 15, population: DELETE_VALVE_MIN_POPULATION + 1 });
    expect(w.allowed).toBe(false);
    expect(w.reason).toBe('ratio');
  });

  test('a zero-population source (fresh, or every page already gone) still has the cap', () => {
    expect(evaluateDeleteValve({ requested: 5, population: 0 }).allowed).toBe(true);
    expect(evaluateDeleteValve({ requested: DELETE_VALVE_ABSOLUTE_CAP + 1, population: 0 }).allowed).toBe(false);
  });
});

describe('evaluateDeleteValve — the only override is an exact expected count', () => {
  test('--allow-deletes N with N ≥ requested lets a refused run through, and says so', () => {
    const v = evaluateDeleteValve({ requested: 1_160, population: 4_488, allowDeletes: 1_160 });
    expect(v.allowed).toBe(true);
    expect(v.overridden).toBe(true);
    expect(v.reason).toBe('absolute_cap'); // the reason is kept for the audit line
  });

  test('--allow-deletes N with N < requested refuses again', () => {
    const v = evaluateDeleteValve({ requested: 1_160, population: 4_488, allowDeletes: 1_000 });
    expect(v.allowed).toBe(false);
    expect(v.overridden).toBe(false);
  });

  test('--allow-deletes on a run within limits is not an override', () => {
    const v = evaluateDeleteValve({ requested: 3, population: 4_488, allowDeletes: 500 });
    expect(v.allowed).toBe(true);
    expect(v.overridden).toBe(false);
  });
});

describe('parseAllowDeletes', () => {
  test('accepts a positive integer', () => {
    expect(parseAllowDeletes('1160')).toBe(1160);
    expect(parseAllowDeletes('1')).toBe(1);
  });

  test('rejects a missing value, zero, negatives, and non-integers — never silently "no override"', () => {
    for (const bad of [undefined, '0', '-1', '1.5', 'abc', '', '1e3']) {
      expect(() => parseAllowDeletes(bad)).toThrow(/--allow-deletes/);
    }
  });
});

describe('formatDeleteValveRefusal', () => {
  test('names the numbers, the limit, the exact re-run, and the absence of an env override', () => {
    const v = evaluateDeleteValve({ requested: 1_160, population: 4_488 });
    const msg = formatDeleteValveRefusal(v, { sourceId: 'curaition', path: 'incremental' });
    expect(msg).toContain('1160 of 4488');
    expect(msg).toContain('25.8%');
    expect(msg).toContain(`more than ${DELETE_VALVE_ABSOLUTE_CAP} pages`);
    expect(msg).toContain('--allow-deletes 1160');
    expect(msg).toContain('no environment override');
    expect(msg).toContain('Nothing was written');
  });

  test('the full-sync variant says deletes were skipped and the rest continued', () => {
    const v = evaluateDeleteValve({ requested: 40, population: 86 });
    const msg = formatDeleteValveRefusal(v, { sourceId: 'curaition', path: 'full' });
    expect(msg).toContain('No pages were deleted');
    expect(msg).toContain(`more than ${Math.round(DELETE_VALVE_RATIO * 100)}%`);
  });

  test('a too-small --allow-deletes is called out by number', () => {
    const v = evaluateDeleteValve({ requested: 1_160, population: 4_488, allowDeletes: 1_000 });
    const msg = formatDeleteValveRefusal(v, { sourceId: 'curaition', path: 'incremental' });
    expect(msg).toContain('--allow-deletes 1000 was given but is below the requested 1160');
  });
});
