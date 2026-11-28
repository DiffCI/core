import type { OutcomeRecord } from "./outcome-log.js";
import { timingsFromOutcomes } from "./test-shards.js";

/**
 * What a selected run cost next to the full suite (2026-11-28, DiffCI/core#355).
 *
 * WHY. On DentalPresence a change to a shared gateway module selected about 300 D1 integration files, each
 * booting a local workerd. The selected run took 638-675s where the full suite takes 217s, and the report
 * said "selected 299/647", which reads as a saving. A count says nothing about cost.
 *
 * WHAT. From the local outcome log: the summed typical duration of each file this run executes (the
 * selection plus the affected files outside the full test command), next to the summed per-file time of
 * the newest full run and the median wall time of recent full runs. Files without a recorded duration are
 * counted, not guessed, so the selected sum is a lower bound and "exceeds" can only be understated.
 */
export interface RunCost {
  /** Summed typical durations of the files this run executes, where the outcome log has one. */
  selected_file_ms: number;
  /** The part of selected_file_ms spent on files outside the full test command, which run in addition to it. */
  outside_suite_file_ms: number;
  /** Executed files with no recorded duration; the sums leave them out. */
  untimed_files: number;
  /** Summed per-file durations of the newest passing full run that recorded them. */
  full_file_ms?: number;
  /** Median test wall time of the last five passing full runs. */
  full_wall_ms?: number;
  /** This run's own test wall time. */
  actual_wall_ms?: number;
  /** True when the run cost at least as much as the full suite, by summed file time or by wall time. */
  exceeds_full: boolean;
}

const FULL_RUNS = 5;

export function estimateRunCost(
  records: readonly OutcomeRecord[],
  selectedTests: readonly string[],
  outsideTests: readonly string[],
  actualWallMs?: number,
): RunCost | undefined {
  const timings = timingsFromOutcomes(records).files;
  const sum = (files: readonly string[]) => files.reduce((total, file) => total + (timings[file] ?? 0), 0);
  const executed = [...new Set([...selectedTests, ...outsideTests])];
  const untimed = executed.filter((file) => timings[file] === undefined).length;
  const fullRuns = records.filter((record) => record.selection === "full" && record.verification === "passed" && !record.reused_from && record.tests_ms !== undefined);
  const newestTimed = [...fullRuns].reverse().find((record) => record.test_results?.some((result) => result.ms !== undefined));
  const fullFileMs = newestTimed?.test_results?.reduce((total, result) => total + (result.ms ?? 0), 0);
  const fullWallMs = median(fullRuns.slice(-FULL_RUNS).map((record) => record.tests_ms!));
  if (untimed === executed.length && fullWallMs === undefined) return undefined;
  const selectedFileMs = sum(executed);
  const exceeds = (fullFileMs !== undefined && untimed < executed.length && selectedFileMs >= fullFileMs)
    || (fullWallMs !== undefined && actualWallMs !== undefined && actualWallMs >= fullWallMs);
  return {
    selected_file_ms: selectedFileMs,
    outside_suite_file_ms: sum(outsideTests.filter((file) => !selectedTests.includes(file))),
    untimed_files: untimed,
    ...(fullFileMs !== undefined ? { full_file_ms: fullFileMs } : {}),
    ...(fullWallMs !== undefined ? { full_wall_ms: fullWallMs } : {}),
    ...(actualWallMs !== undefined ? { actual_wall_ms: actualWallMs } : {}),
    exceeds_full: exceeds,
  };
}

/** One line for the verify summary, or undefined when there is nothing to compare against. */
export function formatRunCost(cost: RunCost, outsideCount: number): string | undefined {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const parts: string[] = [];
  if (cost.full_file_ms !== undefined && cost.untimed_files === 0) parts.push(`test time ${s(cost.selected_file_ms)} vs ${s(cost.full_file_ms)} for the full suite`);
  else if (cost.full_file_ms !== undefined) parts.push(`test time at least ${s(cost.selected_file_ms)} (${cost.untimed_files} file(s) untimed) vs ${s(cost.full_file_ms)} for the full suite`);
  if (cost.actual_wall_ms !== undefined && cost.full_wall_ms !== undefined) parts.push(`this run ${s(cost.actual_wall_ms)} vs ${s(cost.full_wall_ms)} median full run`);
  if (!parts.length) return undefined;
  const outside = outsideCount ? `; ${outsideCount} file(s) outside the full test command ran in addition to it (${s(cost.outside_suite_file_ms)})` : "";
  return cost.exceeds_full
    ? `  cost: this selection cost MORE than the full suite: ${parts.join("; ")}${outside}`
    : `  cost: ${parts.join("; ")}${outside}`;
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
