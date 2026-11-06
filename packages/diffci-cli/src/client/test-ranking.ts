import type { OutcomeRecord } from "./outcome-log.js";
import type { SelectionReason } from "./report.js";

/**
 * Ranking selected tests by failure history (2026-11-06), the idea of Launchable (CloudBees Smart Tests)
 * applied to the local outcome log.
 *
 * WHY. The selection decides what runs; the order decides how soon a failure is seen. An agent that sees
 * the failing test first fixes it sooner, and `--fail-fast` can stop before the rest.
 *
 * WHAT. A heuristic, not a model: each test file's failures in the outcome log, each run weighted by how
 * recent it is (a run HALF_LIFE runs ago counts half), over the runs it took part in. A test the change
 * itself edited or added ranks with the most likely. Ties go to the faster test, then to the given order.
 * Ranking only reorders: every selected test still runs. A learned model across repositories belongs to
 * DiffCI Cloud, once there is outside data to learn from (docs/strategy.md, Predict).
 */

const HALF_LIFE = 20;
const CHANGED_TEST_REASONS = new Set(["DIRECT_TEST_CHANGE", "NEW_TEST_FILE"]);

export interface TestHistory {
  /** Recency-weighted failures and runs per test file. */
  failures: Map<string, number>;
  runs: Map<string, number>;
  /** The latest known duration per test file. */
  ms: Map<string, number>;
}

export function testHistory(records: readonly OutcomeRecord[]): TestHistory {
  const history: TestHistory = { failures: new Map(), runs: new Map(), ms: new Map() };
  const withResults = records.filter((record) => record.test_results?.length);
  withResults.forEach((record, index) => {
    const weight = 0.5 ** ((withResults.length - 1 - index) / HALF_LIFE);
    for (const result of record.test_results!) {
      history.runs.set(result.file, (history.runs.get(result.file) ?? 0) + weight);
      if (result.status === "failed") history.failures.set(result.file, (history.failures.get(result.file) ?? 0) + weight);
      if (result.ms !== undefined) history.ms.set(result.file, result.ms);
    }
  });
  return history;
}

/** How likely `test` is to fail, from 0 to 1: its weighted failure rate, smoothed toward 0 for few runs,
 * or 1 for a test the change edited or added. */
export function failureScore(test: string, history: TestHistory, reason?: SelectionReason): number {
  if (reason && CHANGED_TEST_REASONS.has(reason.reason)) return 1;
  const failures = history.failures.get(test) ?? 0;
  return failures / ((history.runs.get(test) ?? 0) + 1);
}

/** `tests` with the likeliest failures first; ties go to the faster test, then keep their given order. */
export function rankTests(tests: readonly string[], history: TestHistory, reasons: Record<string, SelectionReason> = {}): string[] {
  return tests
    .map((test, index) => ({ test, index, score: failureScore(test, history, reasons[test]), ms: history.ms.get(test) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => b.score - a.score || a.ms - b.ms || a.index - b.index)
    .map(({ test }) => test);
}

/** The ranked tests worth running first under `--fail-fast`: those with any failure history, or edited. */
export function likelyFailures(tests: readonly string[], history: TestHistory, reasons: Record<string, SelectionReason> = {}): string[] {
  return tests.filter((test) => failureScore(test, history, reasons[test]) > 0);
}

/** One point of the confidence curve: within `time_share` of the test time, `detected_share` of failing runs. */
export interface CurvePoint {
  time_share: number;
  detected_share: number;
}

export interface ConfidenceCurve {
  /** Failing runs with per-file durations that the curve replays. */
  failing_runs: number;
  /** Ranked by the history before each run, against the runner's file order (by path). */
  ranked: CurvePoint[];
  by_path: CurvePoint[];
  /** Median share of the run's test time spent before the first failure. */
  median_ranked?: number;
  median_by_path?: number;
}

/** Share of the run's test time spent before the first failing file starts, with files run in `order`. */
function timeToFirstFailure(order: readonly string[], record: OutcomeRecord): number | undefined {
  const results = new Map(record.test_results!.map((result) => [result.file, result]));
  const total = record.test_results!.reduce((sum, result) => sum + (result.ms ?? 0), 0);
  if (total <= 0) return undefined;
  let elapsed = 0;
  for (const file of order) {
    const result = results.get(file)!;
    if (result.status === "failed") return elapsed / total;
    elapsed += result.ms ?? 0;
  }
  return undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The confidence curve: replays every failing run that recorded per-file durations, ranking its files by
 * the history of the runs BEFORE it (never its own result), and reports how much of the test time passes
 * before the first failure. Compared with the files in path order, roughly how the runners schedule them.
 */
export function confidenceCurve(records: readonly OutcomeRecord[], steps = 10): ConfidenceCurve {
  const ranked: number[] = [];
  const byPath: number[] = [];
  records.forEach((record, index) => {
    if (!record.test_results?.some((result) => result.status === "failed")) return;
    if (!record.test_results.every((result) => result.ms !== undefined)) return;
    // Path order is both the baseline and the ranking's tie-break, so ranking can only move files from it.
    const files = record.test_results.map((result) => result.file).sort();
    const history = testHistory(records.slice(0, index));
    const rankedShare = timeToFirstFailure(rankTests(files, history, record.selection_reasons), record);
    const pathShare = timeToFirstFailure(files, record);
    if (rankedShare === undefined || pathShare === undefined) return;
    ranked.push(rankedShare);
    byPath.push(pathShare);
  });
  const curve = (shares: number[]) => Array.from({ length: steps }, (_, step) => {
    const time_share = (step + 1) / steps;
    return { time_share, detected_share: shares.length ? shares.filter((share) => share < time_share).length / shares.length : 0 };
  });
  const medianRanked = median(ranked);
  const medianByPath = median(byPath);
  return {
    failing_runs: ranked.length,
    ranked: curve(ranked),
    by_path: curve(byPath),
    ...(medianRanked !== undefined ? { median_ranked: medianRanked } : {}),
    ...(medianByPath !== undefined ? { median_by_path: medianByPath } : {}),
  };
}

export function formatConfidenceCurve(curve: ConfidenceCurve): string {
  if (curve.failing_runs === 0) {
    return "Confidence curve: no failing run with per-file durations in the outcome log yet; it fills as verify runs fail.";
  }
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const lines = [
    `Confidence curve over ${curve.failing_runs} failing run(s): share of failing runs whose first failure is seen within each share of test time`,
    "  test time   ranked by history   by path",
  ];
  curve.ranked.forEach((point, index) => {
    lines.push(`  ${percent(point.time_share).padStart(9)}   ${percent(point.detected_share).padStart(17)}   ${percent(curve.by_path[index]!.detected_share).padStart(7)}`);
  });
  if (curve.median_ranked !== undefined && curve.median_by_path !== undefined) {
    lines.push(`  median test time before the first failure: ${percent(curve.median_ranked)} ranked, ${percent(curve.median_by_path)} by path`);
  }
  if (curve.failing_runs < 10) lines.push("  fewer than 10 failing runs: read this as an early signal, not a measurement");
  return lines.join("\n");
}
