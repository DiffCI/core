import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { detectAgentFromEnvironment } from "./agent-identity.js";
import type { SelectionReason } from "./report.js";
import type { TestFileResult } from "./test-results.js";
import type { VerificationReport } from "./verify.js";

/**
 * The local outcome log (2026-11-05).
 *
 * WHY. Every verify run decides what to run and then learns what happened. Kept, those pairs are the
 * training data for ranking tests and the only way to measure misses over time; they cannot be
 * reconstructed afterwards. Receipts were written only when asked for (`--out`) and dropped otherwise.
 *
 * WHAT. One JSON line per `diffci verify`, appended to `<git common dir>/diffci/outcomes.jsonl`: inside
 * `.git`, so it is never committed, never an untracked file that changes the next snapshot, and shared
 * by every worktree of the repository. It holds the plan (selection, reasons, checks), the result, the
 * durations and the failing tests. Nothing is sent anywhere. `--no-log` or DIFFCI_OUTCOME_LOG=0 skip it.
 */

export const OUTCOME_SCHEMA = "diffci.outcome.v1" as const;

export interface OutcomeRecord {
  schema: typeof OUTCOME_SCHEMA;
  produced_at: string;
  diffci_version?: string;
  agent?: string;
  scope: VerificationReport["scope"];
  base_sha: string;
  head_sha?: string;
  /** The verified tree; runs on the same tree verified the same content. */
  tree_sha: string;
  verification: VerificationReport["verification"];
  selection: VerificationReport["selection"];
  tests_selected: number;
  tests_available: number;
  selected_tests?: string[];
  selection_reasons?: Record<string, SelectionReason>;
  fallback_reasons: string[];
  analysis_ms?: number;
  tests_ms?: number;
  exit_code?: number | null;
  failing_tests?: string[];
  checks?: Array<{ id: string; decision: string; status: string; wall_ms?: number; command?: string }>;
  /** The test command as run, and the Node version it ran under (2026-11-06). */
  command?: string;
  node_version?: string;
  /** Each test file's result and duration, where the runner showed them (test-results.ts, 2026-11-06). */
  test_results?: TestFileResult[];
  /** When this run ran nothing and reused an earlier pass: that run's `produced_at` (reusablePass). */
  reused_from?: string;
}

export function outcomeRecord(report: VerificationReport, env: Record<string, string | undefined> = {}): OutcomeRecord {
  const agent = detectAgentFromEnvironment(env);
  return {
    schema: OUTCOME_SCHEMA,
    produced_at: report.produced_at,
    ...(report.diffci_version ? { diffci_version: report.diffci_version } : {}),
    ...(agent ? { agent } : {}),
    scope: report.scope,
    base_sha: report.commit_range?.base_sha ?? report.snapshot.base_sha,
    ...(report.commit_range ? { head_sha: report.commit_range.head_sha } : {}),
    tree_sha: report.snapshot.before_tree_sha,
    verification: report.verification,
    selection: report.selection,
    tests_selected: report.tests_selected,
    tests_available: report.tests_available,
    ...(report.selected_tests ? { selected_tests: report.selected_tests } : {}),
    ...(report.selection_reasons ? { selection_reasons: report.selection_reasons } : {}),
    fallback_reasons: report.analysis.fallback_reasons,
    ...(report.analysis.duration_ms !== undefined ? { analysis_ms: report.analysis.duration_ms } : {}),
    ...(report.execution ? { tests_ms: report.execution.wallMs, exit_code: report.execution.exitCode } : {}),
    ...(report.execution?.failingTests?.length ? { failing_tests: report.execution.failingTests } : {}),
    ...(report.checks ? { checks: report.checks.map((check) => ({ id: check.id, decision: check.decision, status: check.status, ...(check.wall_ms !== undefined ? { wall_ms: check.wall_ms } : {}), command: check.command })) } : {}),
    ...(report.command ? { command: report.commands?.join(" && ") ?? report.command } : {}),
    node_version: process.versions.node,
    ...(report.execution?.testResults?.length ? { test_results: report.execution.testResults } : {}),
    ...(report.reused_from ? { reused_from: report.reused_from.produced_at } : {}),
  };
}

/** What a verify run is about to execute, for reusablePass. */
export interface ReuseQuery {
  tree_sha: string;
  diffci_version: string;
  node_version: string;
  selection: "selected" | "full";
  selected_tests: readonly string[];
  /** The command this run would execute, and the repository's full test command. */
  command: string;
  full_command?: string;
  /** The gate checks this run would execute (decision RUN or NARROWED), with their exact commands. */
  checks: ReadonlyArray<{ id: string; command: string }>;
}

/**
 * Result reuse by tree (2026-11-06), the idea of Turborepo's and Bazel's caches applied to a verify run.
 *
 * WHY. Agents re-run verify on a tree that has not changed since the last pass: after a commit, after a
 * rebase that changed nothing, from a second worktree. Running the same tests on the same bytes again
 * learns nothing.
 *
 * WHAT. The newest earlier run that passed on the same tree, under the same DiffCI and Node versions, and
 * that covers what this run would execute: a full run of the same full command, or a selected run whose
 * tests include every test selected now. Every gate check this run would execute must have passed in it
 * with the identical command, so a check narrowed to other files does not count. Only passes are reused;
 * a reused run is never itself a source. The tree covers the lockfile but not node_modules, so a changed
 * install with an unchanged lockfile is the one thing reuse cannot see; `--no-reuse` runs everything.
 */
export function reusablePass(records: readonly OutcomeRecord[], query: ReuseQuery): OutcomeRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const run = records[index]!;
    if (run.reused_from || run.verification !== "passed" || run.tree_sha !== query.tree_sha) continue;
    if (run.diffci_version !== query.diffci_version || run.node_version !== query.node_version) continue;
    const tests = run.selection === "full"
      ? run.command !== undefined && run.command === (query.selection === "full" ? query.command : query.full_command)
      : run.selection === "selected" && query.selection === "selected" && run.selected_tests !== undefined
        && query.selected_tests.every((test) => run.selected_tests!.includes(test));
    if (!tests) continue;
    const passedChecks = new Set((run.checks ?? []).filter((check) => check.status === "passed" && check.command).map((check) => `${check.id}\n${check.command}`));
    if (query.checks.every((check) => passedChecks.has(`${check.id}\n${check.command}`))) return run;
  }
  return undefined;
}

/** `<git common dir>/diffci/outcomes.jsonl`, or undefined outside a Git repository. */
export function outcomeLogPath(repoPath: string): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return join(resolve(repoPath, common), "diffci", "outcomes.jsonl");
  } catch {
    return undefined;
  }
}

/** Appends the run to the log. Best effort: a log that cannot be written never fails verification. */
export function appendOutcome(repoPath: string, report: VerificationReport, env: Record<string, string | undefined>): string | undefined {
  if (env.DIFFCI_OUTCOME_LOG === "0") return undefined;
  const path = outcomeLogPath(repoPath);
  if (!path) return undefined;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `${JSON.stringify(outcomeRecord(report, env))}\n`, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/** Every well-formed record in the log, oldest first; malformed lines are skipped. */
export function readOutcomes(path: string): OutcomeRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const record = JSON.parse(line) as OutcomeRecord;
      return record.schema === OUTCOME_SCHEMA ? [record] : [];
    } catch {
      return [];
    }
  });
}

/**
 * A selected run that passed and a later full run of the same tree that failed: the selection left out
 * something that fails. Possible, not proven - a flaky test fails the same way - so it is reported as
 * a lead. Misses on CI full runs are classified by `diffci enforce-misses`.
 */
export interface PossibleMiss {
  tree_sha: string;
  selected_at: string;
  full_at: string;
  failing_tests: string[];
}

export interface OutcomeSummary {
  runs: number;
  passed: number;
  failed: number;
  blocked: number;
  selected: number;
  full: number;
  /** Median wall time of the test command, by selection. */
  median_selected_ms?: number;
  median_full_ms?: number;
  top_fallback_reasons: Array<{ reason: string; runs: number }>;
  agents: Record<string, number>;
  possible_misses: PossibleMiss[];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function summarizeOutcomes(records: readonly OutcomeRecord[]): OutcomeSummary {
  const fallback = new Map<string, number>();
  for (const record of records) {
    if (record.selection !== "full") continue;
    for (const reason of new Set(record.fallback_reasons)) fallback.set(reason, (fallback.get(reason) ?? 0) + 1);
  }
  const agents: Record<string, number> = {};
  for (const record of records) agents[record.agent ?? "none"] = (agents[record.agent ?? "none"] ?? 0) + 1;
  const possible_misses: PossibleMiss[] = [];
  records.forEach((full, index) => {
    if (full.selection !== "full" || full.verification !== "failed") return;
    const earlier = records.slice(0, index).reverse().find((run) => run.tree_sha === full.tree_sha && run.selection === "selected" && run.verification === "passed");
    if (earlier) possible_misses.push({ tree_sha: full.tree_sha, selected_at: earlier.produced_at, full_at: full.produced_at, failing_tests: full.failing_tests ?? [] });
  });
  const ms = (selection: OutcomeRecord["selection"]) => records.filter((r) => r.selection === selection && r.tests_ms !== undefined).map((r) => r.tests_ms!);
  const medianSelected = median(ms("selected"));
  const medianFull = median(ms("full"));
  return {
    runs: records.length,
    passed: records.filter((r) => r.verification === "passed").length,
    failed: records.filter((r) => r.verification === "failed").length,
    blocked: records.filter((r) => r.verification === "blocked").length,
    selected: records.filter((r) => r.selection === "selected").length,
    full: records.filter((r) => r.selection === "full").length,
    ...(medianSelected !== undefined ? { median_selected_ms: medianSelected } : {}),
    ...(medianFull !== undefined ? { median_full_ms: medianFull } : {}),
    top_fallback_reasons: [...fallback].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([reason, runs]) => ({ reason, runs })),
    agents,
    possible_misses,
  };
}

export function formatOutcomeSummary(summary: OutcomeSummary, path: string): string {
  const seconds = (value: number | undefined) => value === undefined ? "-" : `${(value / 1000).toFixed(1)}s`;
  const lines = [
    `DiffCI outcomes: ${summary.runs} verify run(s) in ${path}`,
    `  results: ${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked`,
    `  selection: ${summary.selected} selected (median tests ${seconds(summary.median_selected_ms)}), ${summary.full} full (median ${seconds(summary.median_full_ms)})`,
    `  agents: ${Object.entries(summary.agents).map(([agent, runs]) => `${agent} ${runs}`).join(", ") || "-"}`,
  ];
  if (summary.top_fallback_reasons.length) {
    lines.push("  top full-run reasons:");
    for (const { reason, runs } of summary.top_fallback_reasons) lines.push(`    ${runs}x ${reason}`);
  }
  lines.push(`  possible misses: ${summary.possible_misses.length}`);
  for (const miss of summary.possible_misses) {
    lines.push(`    tree ${miss.tree_sha.slice(0, 12)}: selected run passed ${miss.selected_at}, full run failed ${miss.full_at}${miss.failing_tests.length ? ` (${miss.failing_tests.slice(0, 3).join(", ")})` : ""}`);
  }
  return lines.join("\n");
}
