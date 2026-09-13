/**
 * Test: the reconcile must never classify a RENAMED file as a deletion.
 *
 * Regression cover for the 2026-09-11 incident: a repository restructure moved
 * 1,141 `.py` files; the reconcile's ever-committed check runs with rename
 * detection off (`git log --all --no-renames --diff-filter=A`), so every
 * renamed-away path answered "yes, ever committed" and "absent from the tree"
 * and landed in the delete bucket. 1,139 pages were destroyed. Only 50 of those
 * paths were genuine deletions.
 *
 * Pure-helper surface: takes plain inputs, reads no engine and no git, so this
 * runs without PGLite and without a working tree.
 */

import { describe, test, expect } from 'bun:test';
import { partitionRenamedAway } from '../src/core/sync-reconcile.ts';

/** Stale rows (absent from the current walk) from a list of source_paths. */
function stale(paths: string[]): Array<{ slug: string; source_path: string }> {
  return paths.map((p, i) => ({ slug: `slug-${i}`, source_path: p }));
}

describe('partitionRenamedAway — content survival gates deletion', () => {
  test('a path whose blob still exists elsewhere in the tree is NOT deletable', () => {
    // The file moved from core/scheduling/ to platform/tasks/. Same content,
    // new address. Its page must survive.
    const rows = stale(['src/core/scheduling/tasks.py']);
    const blobAtLastSync = new Map([['src/core/scheduling/tasks.py', 'blob-aaa']]);
    const survivingBlobs = new Set(['blob-aaa', 'blob-zzz']);

    const out = partitionRenamedAway(rows, blobAtLastSync, survivingBlobs);

    expect(out.deletable).toEqual([]);
    expect(out.renamedAway).toEqual(['slug-0']);
  });

  test('a path whose blob is absent from the tree IS deletable', () => {
    const rows = stale(['scripts/gone.py']);
    const blobAtLastSync = new Map([['scripts/gone.py', 'blob-dead']]);
    const survivingBlobs = new Set(['blob-aaa']);

    const out = partitionRenamedAway(rows, blobAtLastSync, survivingBlobs);

    expect(out.deletable).toEqual(['slug-0']);
    expect(out.renamedAway).toEqual([]);
  });

  test('a path with no recorded blob is PRESERVED, not deleted', () => {
    // Fail-safe direction: a wrong delete is unrecoverable (hard DELETE, no
    // soft-delete, page_versions keys on page_id). A wrong keep is a stale row.
    // When survival cannot be proven, keep.
    const rows = stale(['src/unknown.py']);
    const blobAtLastSync = new Map<string, string>();
    const survivingBlobs = new Set(['blob-aaa']);

    const out = partitionRenamedAway(rows, blobAtLastSync, survivingBlobs);

    expect(out.deletable).toEqual([]);
    expect(out.unprovable).toEqual(['slug-0']);
  });

  test('the incident shape: a rename wave yields only the true deletions', () => {
    // 8 moved files + 2 genuinely removed. Pre-fix this deleted all 10.
    const moved = Array.from({ length: 8 }, (_, i) => `src/core/old/m${i}.py`);
    const removed = ['src/gone/a.py', 'src/gone/b.py'];
    const rows = stale([...moved, ...removed]);

    const blobAtLastSync = new Map<string, string>();
    moved.forEach((p, i) => blobAtLastSync.set(p, `blob-moved-${i}`));
    removed.forEach((p, i) => blobAtLastSync.set(p, `blob-removed-${i}`));

    // The moved files' content is still in the tree, at new paths.
    const survivingBlobs = new Set(moved.map((_, i) => `blob-moved-${i}`));

    const out = partitionRenamedAway(rows, blobAtLastSync, survivingBlobs);

    expect(out.deletable).toEqual(['slug-8', 'slug-9']);
    expect(out.renamedAway).toHaveLength(8);
  });
});
