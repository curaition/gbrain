/** Managed clones honour `sources.config.branch` at clone time (2026-09-15). */
import { describe, test, expect } from 'bun:test';
import { getRemoteBranch } from '../src/core/sources-ops.ts';

describe('getRemoteBranch', () => {
  test('reads a plain branch name from object or JSON-string config', () => {
    expect(getRemoteBranch({ remote_url: 'https://x', branch: 'staging' })).toBe('staging');
    expect(getRemoteBranch('{"branch":"release/2026.09"}')).toBe('release/2026.09');
  });
  test('absent, non-string or unsafe values → undefined (repository default branch)', () => {
    expect(getRemoteBranch({})).toBeUndefined();
    expect(getRemoteBranch(null)).toBeUndefined();
    expect(getRemoteBranch({ branch: 7 })).toBeUndefined();
    expect(getRemoteBranch({ branch: '--upload-pack=evil' })).toBeUndefined();
    expect(getRemoteBranch({ branch: 'a b' })).toBeUndefined();
  });
});
