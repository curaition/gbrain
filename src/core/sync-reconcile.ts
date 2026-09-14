/**
 * Full-sync reconcile planning (#2828 mass-delete valve, #2426 ever-committed
 * gate) + sync deadline/stall resolution (#1633, #1950). Peeled out of
 * src/commands/sync.ts (containment sprint C13-C14) as a pure move.
 */
import { execFileSync } from 'child_process';
import { parseDurationSeconds } from './sync-concurrency.ts';

/**
 * #2828 full-sync reconcile safety-valve thresholds. A reconcile that would
 * delete more than MASS_RECONCILE_RATIO of the file-backed pages a strategy
 * manages, on a source that holds more than MASS_RECONCILE_MIN_PAGES of them, is
 * treated as a suspected path-comparison bug rather than a real bulk deletion.
 */
export const MASS_RECONCILE_RATIO = 0.5;
export const MASS_RECONCILE_MIN_PAGES = 20;

/**
 * Normalize path separators so a page whose stored `source_path` was written
 * with a different separator than the local OS's `path.relative` produces (e.g.
 * git-derived forward-slash paths on a Windows checkout) still compares equal.
 * Without this, on Windows every file-backed page looks stale and the reconcile
 * wrongly deletes the whole source (#2828).
 */
function normalizeReconcilePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export interface ReconcilePlan {
  /** Slugs whose backing file is genuinely gone; safe to reconcile-delete. */
  staleSlugs: string[];
  /**
   * File-backed, in-strategy pages the reconcile can act on. This is the
   * denominator for the mass-delete valve (the exact population at risk).
   */
  reconcilableCount: number;
  /**
   * True when `staleSlugs` would sweep more than MASS_RECONCILE_RATIO of
   * `reconcilableCount`, on a source with more than MASS_RECONCILE_MIN_PAGES of
   * them — the mass-delete signal that trips the safety valve.
   */
  massDelete: boolean;
}

/**
 * #2828: decide which file-backed pages a full-sync reconcile should delete, and
 * whether that deletion is suspiciously large. Pure and exported so both the
 * separator normalization and the mass-delete valve are unit-testable without a
 * live engine or a Windows host.
 *
 * @param rows           pages with a non-null `source_path` (deleted_at IS NULL).
 * @param currentFiles   repo-relative paths present in the working tree.
 * @param isSyncablePath predicate excluding metafiles and the wrong strategy.
 */
export function planReconcileDeletes(
  rows: ReadonlyArray<{ slug: string; source_path: string | null }>,
  currentFiles: Iterable<string>,
  isSyncablePath: (p: string) => boolean,
): ReconcilePlan {
  const current = new Set<string>();
  for (const f of currentFiles) current.add(normalizeReconcilePath(f));
  const reconcilable = rows.filter(
    r => r.source_path != null && isSyncablePath(r.source_path),
  );
  const staleSlugs = reconcilable
    .filter(r => !current.has(normalizeReconcilePath(r.source_path as string)))
    .map(r => r.slug);
  const massDelete =
    reconcilable.length > MASS_RECONCILE_MIN_PAGES &&
    staleSlugs.length > reconcilable.length * MASS_RECONCILE_RATIO;
  return { staleSlugs, reconcilableCount: reconcilable.length, massDelete };
}

/**
 * Outcome of gating stale rows on whether their CONTENT survived the tree.
 */
export interface RenamePartition {
  /** Content is gone from the tree — a genuine deletion, safe to reconcile. */
  deletable: string[];
  /** Content survives at another path — a RENAME, never a deletion. */
  renamedAway: string[];
  /** Survival could not be determined — preserved, and surfaced to the caller. */
  unprovable: string[];
}

/**
 * Gate reconcile deletions on content survival, not path survival.
 *
 * The 2026-09-11 incident: a repository restructure MOVED 1,141 `.py` files.
 * The ever-committed check (`listEverCommittedPaths`) runs `git log` with
 * `--no-renames`, so every renamed-away path answered "yes, ever committed"
 * and "absent from the current tree" — the exact signature of a genuine
 * deletion. 1,139 pages were destroyed. Measured afterwards against the same
 * commit range, only **50** of those paths were true deletions.
 *
 * A path is only a deletion if its CONTENT is gone. Blob identity is the
 * primary gate because it survives renames, squashes and history rewrites in
 * one predicate, where a rename ledger has to be threaded through each.
 *
 * `unprovable` rows are PRESERVED, never deleted. The asymmetry is deliberate:
 * page deletes are a hard `DELETE FROM pages` with no soft-delete, and
 * `page_versions` keys on `page_id`, so a wrong delete is unrecoverable from
 * inside the system. A wrong keep is a stale row someone can clean up later.
 *
 * Pure: takes plain inputs, shells out to nothing, so the guard is testable
 * without a working tree or an engine.
 */
export function partitionRenamedAway(
  staleRows: ReadonlyArray<{ slug: string; source_path: string }>,
  blobAtLastSync: ReadonlyMap<string, string>,
  survivingBlobs: ReadonlySet<string>,
): RenamePartition {
  const deletable: string[] = [];
  const renamedAway: string[] = [];
  const unprovable: string[] = [];
  for (const row of staleRows) {
    const blob = blobAtLastSync.get(row.source_path);
    if (blob === undefined) unprovable.push(row.slug);
    else if (survivingBlobs.has(blob)) renamedAway.push(row.slug);
    else deletable.push(row.slug);
  }
  return { deletable, renamedAway, unprovable };
}

/**
 * #2426: every repo-relative path that ever appeared as an ADD in git history
 * (rename detection off, so a `git mv` destination still counts as an add).
 * Used by the full-sync reconcile to distinguish "file was committed and later
 * deleted" (genuine delete → reconcile) from "file was NEVER committed"
 * (DB-only write-through → preserve). Returns null when `repoPath` isn't a git
 * work tree or git is unavailable — callers keep the plain-directory behavior.
 * Forward-slash-normalized to match `normalizeReconcilePath` membership tests.
 */
export function listEverCommittedPaths(repoPath: string): Set<string> | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['-C', repoPath, '-c', 'core.quotepath=off', 'log', '--all', '--no-renames',
        '--diff-filter=A', '--format=', '--name-only'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
  const set = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line) set.add(line.replace(/\\/g, '/'));
  }
  return set;
}

/**
 * #2828 escape hatch: `GBRAIN_ALLOW_MASS_RECONCILE=1` restores the pre-valve
 * behavior for the rare intentional bulk removal. Env-only (an incident-time
 * override), mirroring `resolveStallAbortSeconds`' pure, env-parameterized shape.
 */
export function massReconcileAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GBRAIN_ALLOW_MASS_RECONCILE === '1';
}

// ---------------------------------------------------------------------------
// W2.1 delete valve (curaition remediation, 2026-09-14) — one valve in front of
// EVERY bulk delete path, sized against a denominator that always exists.
//
// Why a second valve when #2828 already exists:
//   * #2828 guards ONLY performFullSync's reconcile. The incremental (delta)
//     path — `git diff --name-status -M` deletions → batched hard
//     `engine.deletePages` — had no valve of any kind.
//   * #2828 divides by the source's FILE-BACKED page count. After the
//     2026-09-13 W1.2 split, a code source's file-backed population is zero by
//     construction (survivors carry source_path NULL), so that ratio has no
//     denominator. This valve divides by the source's LIVE page count.
//   * #2828 is switched off by one persistent environment variable. A service
//     that sets it once has no valve forever. This valve has NO environment
//     override: the only way past it is `--allow-deletes <N>` on the invocation,
//     where N is the number the operator expects to remove. A wrong N refuses.
//
// The 2026-09-11 incident replayed against these thresholds: the run wanted
// 1,160 deletions out of ~4,500 live pages → refused twice over (cap 100,
// ratio 25.8% > 25%). The 50 genuine deletions in the same range → allowed
// (50 ≤ 100, 1.1%).
//
// Sync deletes are HARD (`DELETE FROM pages`, no soft-delete, page_versions
// keyed on page_id), so a wrong delete is unrecoverable from inside the
// system and a wrong refusal costs one re-run with the flag. The asymmetry
// picks refusal.
// ---------------------------------------------------------------------------

/** Most pages one sync run may delete from one source without `--allow-deletes`. */
export const DELETE_VALVE_ABSOLUTE_CAP = 100;
/** Fraction of a source's live pages one run may delete without `--allow-deletes`. */
export const DELETE_VALVE_RATIO = 0.25;
/** Sources at or below this many live pages are judged by the absolute cap only. */
export const DELETE_VALVE_MIN_POPULATION = 20;

export type DeleteValveReason = 'absolute_cap' | 'ratio';

export interface DeleteValveVerdict {
  /** True when the deletes may proceed (nothing to do, within limits, or overridden). */
  allowed: boolean;
  /** Pages the run wants to delete. */
  requested: number;
  /** Live pages of the source at decision time (the ratio denominator). */
  population: number;
  /** Why the limits would refuse, or null when within limits. Set even when overridden. */
  reason: DeleteValveReason | null;
  /** True when limits would refuse but `--allow-deletes N` (N ≥ requested) let it through. */
  overridden: boolean;
  /** The `--allow-deletes` value in force, if any. */
  allowDeletes?: number;
}

/**
 * Decide whether a bulk delete may proceed. Pure: takes counts, reads no
 * engine and no environment, so every branch is unit-testable and the
 * incident can be replayed as a test.
 */
export function evaluateDeleteValve(input: {
  requested: number;
  population: number;
  allowDeletes?: number;
}): DeleteValveVerdict {
  const requested = Math.max(0, Math.floor(input.requested));
  const population = Math.max(0, Math.floor(input.population));
  const allowDeletes = input.allowDeletes;
  let reason: DeleteValveReason | null = null;
  if (requested > DELETE_VALVE_ABSOLUTE_CAP) {
    reason = 'absolute_cap';
  } else if (
    population > DELETE_VALVE_MIN_POPULATION &&
    requested > population * DELETE_VALVE_RATIO
  ) {
    reason = 'ratio';
  }
  if (requested === 0 || reason === null) {
    return { allowed: true, requested, population, reason, overridden: false, allowDeletes };
  }
  const overridden = allowDeletes !== undefined && allowDeletes >= requested;
  return { allowed: overridden, requested, population, reason, overridden, allowDeletes };
}

/**
 * Parse `--allow-deletes <N>`. A positive integer, or an error naming the
 * flag — a malformed value must not silently read as "no override".
 */
export function parseAllowDeletes(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `--allow-deletes requires a positive integer: the number of pages you expect this run to delete` +
      (raw === undefined ? '' : ` (got ${JSON.stringify(raw)})`),
    );
  }
  return Number(raw);
}

/**
 * The refusal message, on stderr and in the result. States the numbers, the
 * limit that fired, and the exact re-run that would be accepted — the operator
 * must type the count, so a path-comparison bug that "deletes" the whole
 * source cannot be waved through with a boolean.
 */
export function formatDeleteValveRefusal(
  verdict: DeleteValveVerdict,
  ctx: { sourceId: string; path: 'incremental' | 'full' },
): string {
  const pct = verdict.population > 0
    ? `${((verdict.requested / verdict.population) * 100).toFixed(1)}%`
    : 'n/a';
  const limit = verdict.reason === 'absolute_cap'
    ? `more than ${DELETE_VALVE_ABSOLUTE_CAP} pages in one run`
    : `more than ${Math.round(DELETE_VALVE_RATIO * 100)}% of the source's live pages`;
  const consequence = ctx.path === 'incremental'
    ? `Nothing was written: adds, modifies and renames are held back with the deletes so the\n` +
      `  bookmark does not advance past a deletion list that was never applied.`
    : `No pages were deleted; the rest of the full sync continued. The next full sync will\n` +
      `  see the same stale pages.`;
  const flagNote = verdict.allowDeletes !== undefined
    ? `\n  --allow-deletes ${verdict.allowDeletes} was given but is below the requested ${verdict.requested}.`
    : '';
  return (
    `\n  REFUSED: the ${ctx.path} sync for source '${ctx.sourceId}' wants to delete ` +
    `${verdict.requested} of ${verdict.population} live page(s) (${pct}) — ${limit}.\n` +
    `  Sync deletes are permanent. Deleting this many at once is almost always a wrong repo\n` +
    `  path, a rename wave read as removals, or a path-comparison bug — not a real bulk removal.\n` +
    `  ${consequence}${flagNote}\n` +
    `  If this removal is genuinely intended, re-run with --allow-deletes ${verdict.requested}\n` +
    `  (the exact number; a smaller number refuses again). There is no environment override.`
  );
}

/**
 * Grace window (seconds) between the watchdog's SIGTERM and SIGKILL. SIGTERM
 * gives a responsive loop a clean shutdown; SIGKILL is the starvation backstop.
 */
export const HARD_DEADLINE_GRACE_SEC = 30;

export interface HardDeadlineResolution {
  deadlineMs: number;
  graceMs: number;
  /** Where the deadline came from (for the armed-log line + tests). */
  reason: string;
}

/**
 * #1950: default no-import-progress window before the in-band stall watchdog
 * aborts the drain. Generous on purpose — it must clear one legitimately large
 * file (cross-region, big page) without false-tripping; one file taking longer
 * than this trips it (documented limit). Distinct from the wall-clock hard
 * deadline (whole-run cap) and the lock heartbeat (refreshes regardless of
 * import progress). Env-tunable; <=0 disables.
 */
export const DEFAULT_SYNC_STALL_ABORT_SEC = 900;

export function resolveStallAbortSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GBRAIN_SYNC_STALL_ABORT_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_SYNC_STALL_ABORT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SYNC_STALL_ABORT_SEC;
  return n; // n <= 0 disables the watchdog
}

/**
 * Resolve the out-of-band hard-deadline for a `gbrain sync` invocation (#1633).
 * Pure + argv/env-only so it runs BEFORE `connectEngine` (so a connect-phase hang
 * is also bounded — `timeout-layer-vs-connectengine` learning). DB-plane config
 * (`gbrain config set`) is unreadable pre-connect, so the operator knob is the
 * `GBRAIN_SYNC_MAX_RUNTIME_SECONDS` env var; bare cron is covered by the non-TTY
 * default. Returns null when no watchdog should arm (TTY interactive with no
 * flag, or an explicit opt-out / 0).
 *
 * Precedence: --no-hard-deadline > --hard-deadline > --timeout(non-all) > env >
 * non-TTY default (3600s) > none.
 */
export function resolveSyncHardDeadline(
  args: string[],
  opts: { isTty: boolean; env?: Record<string, string | undefined>; defaultNonTtySec?: number },
): HardDeadlineResolution | null {
  const env = opts.env ?? {};
  const graceMs = HARD_DEADLINE_GRACE_SEC * 1000;
  const mk = (sec: number, reason: string): HardDeadlineResolution | null =>
    sec > 0 ? { deadlineMs: sec * 1000, graceMs, reason } : null;

  if (args.includes('--no-hard-deadline')) return null;

  const hardStr = args.find((a, i) => args[i - 1] === '--hard-deadline');
  if (hardStr !== undefined) {
    // Throws on a bad value (cli.ts surfaces it + exits 1) — same posture as --timeout.
    const sec = parseDurationSeconds(hardStr, '--hard-deadline');
    return mk(sec ?? 0, 'flag:--hard-deadline');
  }

  // --timeout auto-arms a hard backstop at timeout(+grace), but ONLY single-source.
  // For --all, per-source budgets don't collapse to one wall-clock; fall through.
  const isAll = args.includes('--all');
  const timeoutStr = args.find((a, i) => args[i - 1] === '--timeout');
  if (timeoutStr !== undefined && !isAll) {
    const sec = parseDurationSeconds(timeoutStr, '--timeout');
    if (sec && sec > 0) return mk(sec, 'flag:--timeout');
  }

  const envRaw = env.GBRAIN_SYNC_MAX_RUNTIME_SECONDS;
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return mk(n, 'env:GBRAIN_SYNC_MAX_RUNTIME_SECONDS'); // n<=0 disables
  }

  if (!opts.isTty) return mk(opts.defaultNonTtySec ?? 3600, 'default:non-tty');

  return null;
}

/**
 * Compose 1..N AbortSignals into one (CQ2). Undefined inputs are dropped; the
 * result aborts when ANY input aborts. Returns a single signal directly (no
 * wrapper), `undefined` when nothing is set. Used at both performSync call sites
 * so the SIGINT graceful-cancel signal and the per-source `--timeout` signal
 * compose without duplicating `AbortSignal.any` logic.
 */
export function composeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}
