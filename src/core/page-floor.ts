/**
 * W2.2 — absolute per-source page floor (curaition remediation, 2026-09-14).
 *
 * Ratio checks are blind to deletion by construction: after the 2026-09-11
 * loss of 1,139 pages, a report graded the brain "healthy" at 100% embed
 * coverage and was not wrong about anything it measured. A floor is an
 * absolute number of live pages a source must not drop below. It lives in
 * one config row (`doctor.page_floors`, a JSON object of source_id → floor),
 * so it needs no schema change and can be raised by an operator or a cron
 * without a deploy.
 *
 * Pure: parse + evaluate take plain values and read no engine, so the
 * synthetic-hole readback the plan demands is a unit test.
 */

export const PAGE_FLOORS_CONFIG_KEY = 'doctor.page_floors';

export interface PageFloorRow {
  source_id: string;
  live: number;
  /** null when the source has live pages but no configured floor. */
  floor: number | null;
  verdict: 'pass' | 'fail' | 'no_floor';
}

export interface PageFloorEvaluation {
  status: 'ok' | 'warn' | 'fail';
  rows: PageFloorRow[];
  /** Sources whose live count is below their floor. */
  breached: PageFloorRow[];
  /** Live sources with no floor configured — visible, never silently skipped. */
  unfloored: PageFloorRow[];
}

/**
 * Parse the config value. Returns null when unset; throws on a value that is
 * set but unusable — a broken floor config must read as a failure, not as
 * "no floors", or the check silently loses its teeth.
 */
export function parsePageFloors(raw: string | null | undefined): Record<string, number> | null {
  if (raw == null || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${PAGE_FLOORS_CONFIG_KEY} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${PAGE_FLOORS_CONFIG_KEY} must be a JSON object of source_id → floor`);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error(`${PAGE_FLOORS_CONFIG_KEY}: floor for '${k}' must be a non-negative integer (got ${JSON.stringify(v)})`);
    }
    out[k] = n;
  }
  return out;
}

/**
 * Evaluate floors against live counts. `sourceIds`, when given, restricts the
 * report to those sources (the remote doctor's source-isolation contract: a
 * source-bound caller must not learn other sources' counts).
 */
export function evaluatePageFloors(
  floors: Record<string, number>,
  live: Record<string, number>,
  sourceIds?: string[],
): PageFloorEvaluation {
  const scope = sourceIds ? new Set(sourceIds) : null;
  const ids = new Set<string>([...Object.keys(floors), ...Object.keys(live)]);
  const rows: PageFloorRow[] = [];
  for (const id of [...ids].sort()) {
    if (scope && !scope.has(id)) continue;
    const n = live[id] ?? 0;
    const floor = Object.prototype.hasOwnProperty.call(floors, id) ? floors[id] : null;
    if (floor === null) {
      // A floored-but-empty source is a breach; a live source with no floor is
      // a gap to report. A source with neither is nothing.
      if (n > 0) rows.push({ source_id: id, live: n, floor: null, verdict: 'no_floor' });
      continue;
    }
    rows.push({ source_id: id, live: n, floor, verdict: n >= floor ? 'pass' : 'fail' });
  }
  const breached = rows.filter(r => r.verdict === 'fail');
  const unfloored = rows.filter(r => r.verdict === 'no_floor');
  const status: PageFloorEvaluation['status'] = breached.length > 0 ? 'fail' : 'ok';
  return { status, rows, breached, unfloored };
}

/** One-line human summary for the doctor `message`. */
export function formatPageFloorMessage(ev: PageFloorEvaluation): string {
  if (ev.breached.length > 0) {
    const parts = ev.breached.map(r => `${r.source_id} ${r.live} < floor ${r.floor}`);
    return (
      `BELOW FLOOR: ${parts.join('; ')}. ` +
      `A source lost pages below its absolute floor — treat as a deletion incident until explained. ` +
      `Snapshots: check pages_snapshot_* / the daily pages snapshot before anything writes.`
    );
  }
  const passed = ev.rows.filter(r => r.verdict === 'pass');
  const head = passed.length > 0
    ? `${passed.length} source(s) at or above floor: ` +
      passed.map(r => `${r.source_id} ${r.live}/${r.floor}`).join(', ')
    : 'no floored sources in scope';
  const tail = ev.unfloored.length > 0
    ? `. ${ev.unfloored.length} live source(s) without a floor: ${ev.unfloored.map(r => `${r.source_id} (${r.live})`).join(', ')}` +
      ` — set one with: gbrain config set ${PAGE_FLOORS_CONFIG_KEY} '<json>'`
    : '';
  return head + tail;
}
