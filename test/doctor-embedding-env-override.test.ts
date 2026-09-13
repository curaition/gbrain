// v0.41.2.1 — embedding_env_override doctor check (D9 #9).
//
// Pinned contracts:
//   - env unset → ok
//   - env+DB agree → ok
//   - env model OR dim disagrees → warn with `details.mismatches[]`
//   - getConfig throws → warn with "couldn't read DB config" message
//   - Cross-surface parity: BOTH buildChecks() and doctorReportRemote()
//     include the check (source-grep regression guard)
//
// Hermetic: PGLite + withEnv per CLAUDE.md R1/R3/R4.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { doctorSource } from './helpers/doctor-source.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks, doctorReportRemote, type Check } from '../src/commands/doctor.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function findCheck(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

describe('embedding_env_override check (buildChecks seam)', () => {
  test('env unset → ok', async () => {
    await withEnv(
      { GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check).toBeDefined();
        expect(check!.status).toBe('ok');
        expect(check!.message).toContain('no embedding env overrides set');
      },
    );
  });

  test('env+DB agree → ok', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('embedding_dimensions', '1280');
    await withEnv(
      {
        GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
        GBRAIN_EMBEDDING_DIMENSIONS: '1280',
      },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('ok');
        expect(check!.message).toContain('agree with DB config');
      },
    );
  });

  test('env model disagrees with DB → warn with details.mismatches', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await withEnv(
      { GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large' },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('warn');
        const details = check!.details as { mismatches: Array<{ key: string; env: string; db: string }> };
        expect(details.mismatches).toHaveLength(1);
        expect(details.mismatches[0].key).toBe('GBRAIN_EMBEDDING_MODEL');
        expect(details.mismatches[0].env).toBe('openai:text-embedding-3-large');
        expect(details.mismatches[0].db).toBe('zeroentropyai:zembed-1');
        // Message includes paste-ready unset
        expect(check!.message).toContain('unset GBRAIN_EMBEDDING_MODEL');
      },
    );
  });

  test('env dim disagrees with DB → warn with details.mismatches', async () => {
    await engine.setConfig('embedding_dimensions', '1280');
    await withEnv(
      { GBRAIN_EMBEDDING_DIMENSIONS: '1536' },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('warn');
        const details = check!.details as { mismatches: Array<{ key: string; env: string; db: string }> };
        expect(details.mismatches).toHaveLength(1);
        expect(details.mismatches[0].key).toBe('GBRAIN_EMBEDDING_DIMENSIONS');
      },
    );
  });

  test('both disagree → 2 mismatches', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('embedding_dimensions', '1280');
    await withEnv(
      {
        GBRAIN_EMBEDDING_MODEL: 'openai:x',
        GBRAIN_EMBEDDING_DIMENSIONS: '1536',
      },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('warn');
        const details = check!.details as { mismatches: Array<{ key: string }> };
        expect(details.mismatches).toHaveLength(2);
        expect(check!.message).toContain('unset GBRAIN_EMBEDDING_MODEL GBRAIN_EMBEDDING_DIMENSIONS');
      },
    );
  });

  // CUR-1556 — the hole that hid a production outage. The mismatch arms are
  // gated `envModel && dbModel` / `envDim && dbDim`, so once the DB rows are
  // cleared (what the v0.46 upgrade runbook's `config unset` step does) the
  // check could never fire again and returned a meaningless `ok` forever.
  test('env set but DB config absent -> warn, not a vacuous ok', async () => {
    await withEnv(
      {
        GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-small',
        GBRAIN_EMBEDDING_DIMENSIONS: '1536',
      },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check).toBeDefined();
        expect(check!.status).toBe('warn');
        expect(check!.message).toContain('NO DB config value');
        const details = check!.details as { unverifiable: Array<{ key: string; env: string }> };
        expect(details.unverifiable).toHaveLength(2);
      },
    );
  });

  test('doctorReportRemote() includes the check (cross-surface parity)', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:something' }, async () => {
      await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
      const report = await doctorReportRemote(engine);
      const check = findCheck(report.checks, 'embedding_env_override');
      expect(check).toBeDefined();
      expect(check!.status).toBe('warn');
    });
  });
});

describe('cross-surface parity (source-grep regression guard)', () => {
  test('doctor.ts wires checkEmbeddingEnvOverride into BOTH buildChecks and doctorReportRemote', () => {
    // Static regression assertion: the helper must be called from BOTH surfaces.
    // If a future maintainer removes the call from one surface, this test fails
    // pointing at the asymmetry.
    const src = doctorSource();
    // The helper is called as `await checkEmbeddingEnvOverride(engine)`
    const matches = src.match(/await checkEmbeddingEnvOverride\(engine\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // CUR-1556: facts_embedding_width_consistency existed in buildChecks() and in
  // doctor-categories, but was never wired into doctorReportRemote -- so the
  // thin-client/MCP surface could not see facts.embedding column drift while
  // every `remember` write failed with a raw pgvector error. Same asymmetry
  // class the test above guards for embedding_env_override.
  test('doctor.ts wires checkFactsEmbeddingWidthConsistency into BOTH buildChecks and doctorReportRemote', () => {
    const src = doctorSource();
    const matches = src.match(/await checkFactsEmbeddingWidthConsistency\(engine\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
