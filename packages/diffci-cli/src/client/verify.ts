import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { batchCommand, measureCommands, orderCommand, splitCommand } from "./command-batches.js";
import { checkAtBaseline, compareWithBaseline, type FailureBaseline } from "./failure-baseline.js";
import { collectEnforcementContext, evaluateEnforcement, type EnforcementDecision } from "./enforce-policy.js";
import { inferFullCommand, inferSelectedCommand, inferSelectedCommands } from "./full-command.js";
import { plannedChecks, runChecks, type CheckResult, type PlannedCheck } from "./gate-checks.js";
import { makeGitRunner, observe } from "./observe.js";
import type { ObservationCommitRange, ObservationReport, SelectionReason } from "./report.js";
import { selectedNodeTests, traceNodeTestFiles, unmatchedNodeTests, unstartedNodeTests } from "./selected-coverage.js";
import { outcomeLogPath, readOutcomes, reusablePass } from "./outcome-log.js";
import { likelyFailures, rankTests, testHistory } from "./test-ranking.js";
import { mergeTestFileResults } from "./test-results.js";
import type { CommandMeasurement } from "./verify-savings.js";
import { captureWorkingTreeSnapshot, snapshotChanges, type SnapshotChange, type WorkingTreeSnapshot } from "./working-tree.js";

export const VERIFICATION_SCHEMA = "diffci.verification.v1" as const;

export type VerificationStatus = "passed" | "failed" | "blocked";
export type VerificationScope = "working-tree" | "commit-range";

export interface VerificationReport {
  schema: typeof VERIFICATION_SCHEMA;
  schema_version: "1";
  produced_at: string;
  /** The DiffCI package that produced the receipt, so cohorts can be split by selector version. */
  diffci_version?: string;
  scope: VerificationScope;
  verification: VerificationStatus;
  safe_to_continue: boolean;
  reason: string;
  changed_files: number;
  tests_available: number;
  tests_selected: number;
  /** Affected tests the full test command does not run; executed after the selection (2026-10-21). */
  tests_outside_full_suite?: number;
  selection: "none" | "selected" | "full";
  /** The test files the selected command ran, when `selection` is "selected". The miss detector reads it. */
  selected_tests?: string[];
  /** Why each selected test was selected (ObservationResult.selectionReasons), when `selection` is "selected". */
  selection_reasons?: Record<string, SelectionReason>;
  command?: string;
  /** The parts `command` was run as, when one invocation would exceed the shell's command-line limit. */
  commands?: string[];
  execution?: CommandMeasurement;
  /** The rest of the repository's gate (lint, typecheck, check scripts), run before the tests. When one
   * fails, the tests do not run and `execution` is that check's run (2026-10-29). */
  checks?: CheckResult[];
  commit_range?: {
    base_sha: string;
    head_sha: string;
    source: ObservationCommitRange["source"];
    merge_base_sha?: string;
  };
  snapshot: {
    base_sha: string;
    before_tree_sha: string;
    after_base_sha?: string;
    after_tree_sha?: string;
    /** The verified files were not changed. New files the run wrote (`written_during_verification`) don't count. */
    unchanged: boolean;
    /** New, non-ignored files that appeared during the checks and tests, at most 20. */
    written_during_verification?: string[];
    /** Files that existed before the run and changed during it, at most 20. Their presence blocks the verdict. */
    changed_during_verification?: SnapshotChange[];
  };
  analysis: {
    status: "not_needed" | ObservationReport["status"];
    stage?: ObservationReport["stage"];
    mode?: ObservationReport["result"] extends infer T ? (T extends { mode: infer M } ? M : never) : never;
    fallback_reasons: string[];
    error?: string;
    /** Wall time of the analysis that chose the verification command. */
    duration_ms?: number;
    /** The graph's own confidence and the confidence after narrowing to this change. */
    graph_confidence?: string;
    effective_graph_confidence?: string;
  };
  required_actions: string[];
  /** Present when a failed verification was rerun at the base commit (`--baseline-on-failure`). */
  failure_baseline?: FailureBaseline;
  /** Present only under `--policy enforce`. `applied` is true when the selected tests replaced the full suite. */
  enforcement?: EnforcementDecision & { applied: boolean };
  /** Present when nothing ran because an earlier pass of this exact tree covered it (outcome-log.ts, reusablePass). */
  reused_from?: { produced_at: string; selection: "selected" | "full"; command?: string };
}

interface VerifyOptions {
  repoPath: string;
  env: Record<string, string | undefined>;
  version: string;
  engineSha?: string;
  timeoutMs: number;
  tailBytes: number;
  redactPaths?: boolean;
  /** Rerun a failed verification at the base commit to tell new failures from existing ones. */
  baselineOnFailure?: boolean;
  /** Run only the tests, not the gate's other checks (`--no-checks`). */
  skipChecks?: boolean;
  /** False runs everything even when an earlier pass of the same tree covers it (`--no-reuse`). */
  reuse?: boolean;
  /** False keeps the selection's own order instead of likeliest failures first (`--no-rank`). */
  rank?: boolean;
  /** Run the likeliest failures first and stop there if one fails (`--fail-fast`). */
  failFast?: boolean;
}

export interface VerifyChangedOptions extends VerifyOptions {}

export interface VerifyRangeOptions extends VerifyOptions {
  baseOverride?: string;
  headOverride?: string;
  /** Opt-in enforce mode (docs/enforce-mode-01-plan.md). Absent means today's behaviour, unchanged. */
  policy?: "enforce";
}

function receiptRange(range: ObservationCommitRange | undefined): VerificationReport["commit_range"] {
  if (!range) return undefined;
  return {
    base_sha: range.baseSha,
    head_sha: range.headSha,
    source: range.source,
    merge_base_sha: range.mergeBaseSha,
  };
}

function baseReport(
  snapshot: WorkingTreeSnapshot,
  scope: VerificationScope,
  range?: ObservationCommitRange,
): Pick<VerificationReport, "schema" | "schema_version" | "produced_at" | "scope" | "commit_range" | "snapshot"> {
  return {
    schema: VERIFICATION_SCHEMA,
    schema_version: "1",
    produced_at: new Date().toISOString(),
    scope,
    commit_range: receiptRange(range),
    snapshot: {
      base_sha: snapshot.baseSha,
      before_tree_sha: snapshot.treeSha,
      unchanged: false,
    },
  };
}

function blocked(
  snapshot: WorkingTreeSnapshot,
  scope: VerificationScope,
  reason: string,
  analysis: VerificationReport["analysis"],
  counts: { changedFiles?: number; testsAvailable?: number; testsSelected?: number } = {},
  range?: ObservationCommitRange,
): VerificationReport {
  return {
    ...baseReport(snapshot, scope, range),
    verification: "blocked",
    safe_to_continue: false,
    reason,
    changed_files: counts.changedFiles ?? 0,
    tests_available: counts.testsAvailable ?? 0,
    tests_selected: counts.testsSelected ?? 0,
    selection: "none",
    analysis,
    required_actions: [reason],
  };
}

function unknownSnapshot(): WorkingTreeSnapshot {
  return { baseSha: "unknown", treeSha: "unknown", commitSha: "unknown", changed: true };
}

async function executeObservation(
  options: VerifyOptions & { policy?: "enforce" },
  scope: VerificationScope,
  before: WorkingTreeSnapshot,
  observation: ObservationReport,
): Promise<VerificationReport> {
  const enforcement = options.policy === "enforce"
    ? evaluateEnforcement(collectEnforcementContext(makeGitRunner(options.repoPath), options.env, observation), observation)
    : undefined;
  const report = await executeWithPolicy(options, scope, before, observation, enforcement);
  if (!enforcement) return report;
  return { ...report, enforcement: { ...enforcement, applied: enforcement.fired_fallback === null && report.selection === "selected" } };
}

async function executeWithPolicy(
  options: VerifyOptions,
  scope: VerificationScope,
  before: WorkingTreeSnapshot,
  observation: ObservationReport,
  enforcement: EnforcementDecision | undefined,
): Promise<VerificationReport> {
  // Under enforce, a fired fallback runs the full suite even where plain verify would block: an
  // unusable analysis is a reason to run everything, never a reason to pass with nothing run.
  const enforcedFull = enforcement !== undefined && enforcement.fired_fallback !== null;
  const result = observation.result;
  const range = observation.commitRange;
  const boundRange = scope === "commit-range" ? range : undefined;
  const counts = {
    changedFiles: result?.changedFileCount ?? 0,
    testsAvailable: result?.totalTestCount ?? 0,
    testsSelected: result?.selectedTests.length ?? 0,
  };
  const analysis: VerificationReport["analysis"] = {
    status: observation.status,
    stage: observation.stage,
    mode: result?.mode,
    fallback_reasons: result?.fallbackReasons ?? [],
    error: observation.reason,
    ...(observation.timings?.totalMs !== undefined ? { duration_ms: observation.timings.totalMs } : {}),
    ...(result?.graph ? { graph_confidence: result.graph.confidence, effective_graph_confidence: result.graph.effectiveConfidence } : {}),
  };

  if ((observation.status !== "OBSERVED" || !result) && !enforcedFull) {
    return blocked(before, scope, observation.reason ?? "DiffCI analysis did not produce a verification plan", analysis, counts, boundRange);
  }
  if (scope === "commit-range") {
    if (!range && !enforcedFull) return blocked(before, scope, "DiffCI did not resolve a commit range", analysis, counts);
    if (range && range.headSha !== before.baseSha) {
      return blocked(
        before,
        scope,
        `the analyzed head ${range.headSha} is not the checked-out HEAD ${before.baseSha}`,
        analysis,
        counts,
        range,
      );
    }
  }

  let afterAnalysis: WorkingTreeSnapshot;
  try {
    afterAnalysis = captureWorkingTreeSnapshot(options.repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocked(before, scope, `could not confirm the post-analysis snapshot: ${message}`, analysis, counts, boundRange);
  }
  if (!observation.nonInterference.worktreeUnchanged || before.baseSha !== afterAnalysis.baseSha || before.treeSha !== afterAnalysis.treeSha) {
    const report = blocked(before, scope, "the working tree changed during DiffCI analysis", analysis, counts, boundRange);
    report.snapshot.after_base_sha = afterAnalysis.baseSha;
    report.snapshot.after_tree_sha = afterAnalysis.treeSha;
    return report;
  }

  const { selection, command, commands, reason, outsideSuite } = enforcedFull || !result
    ? fullSelection(options.repoPath, `enforce fallback (${enforcement?.fired_fallback}): ${enforcement?.detail}`)
    : executableSelection(options.repoPath, result, rankedOrdering(options, result));

  if (!command) {
    const inferred = inferFullCommand(options.repoPath);
    return blocked(before, scope, `no executable verification command is available: ${inferred.reason}`, analysis, counts, boundRange);
  }

  // The gate's other checks run first and stop at the first failure, as `npm run check && npm test` would:
  // these are the failures agents met only after push (docs/design/pipeline-impact.md).
  const checkBase = scope === "commit-range" ? range?.baseSha : before.baseSha;
  const checkHead = scope === "commit-range" ? range?.headSha : before.commitSha;
  const planned = options.skipChecks ? [] : plannedChecks(options.repoPath, checkBase && checkHead ? { baseSha: checkBase, headSha: checkHead } : undefined);
  // An earlier pass of this exact tree that covers these tests and checks ends the run here (2026-11-06).
  // Never under enforce, whose receipt must show the decision it applied, nor for tests outside the full
  // suite, which a full run does not cover.
  const reusable = options.reuse !== false && !enforcement && !outsideSuite
    ? findReusablePass(options, before.treeSha, selection, result?.selectedTests ?? [], commands.join(" && "), planned)
    : undefined;
  if (reusable) {
    const reused_from = { produced_at: reusable.produced_at, selection: reusable.selection as "selected" | "full", ...(reusable.command ? { command: reusable.command } : {}) };
    return {
      ...baseReport(before, scope, boundRange),
      verification: "passed",
      safe_to_continue: true,
      reason: `reused the passing ${reused_from.selection} run of this exact tree from ${reused_from.produced_at}; nothing was run again (--no-reuse runs it)`,
      changed_files: counts.changedFiles,
      tests_available: counts.testsAvailable,
      tests_selected: selection === "full" ? counts.testsAvailable : counts.testsSelected,
      selection,
      ...(selection === "selected" && result ? { selected_tests: result.selectedTests } : {}),
      ...(selection === "selected" && result?.selectionReasons ? { selection_reasons: result.selectionReasons } : {}),
      command,
      ...(commands.length > 1 ? { commands } : {}),
      snapshot: { ...baseReport(before, scope, boundRange).snapshot, after_base_sha: before.baseSha, after_tree_sha: before.treeSha, unchanged: true },
      analysis,
      required_actions: [],
      reused_from,
    };
  }
  const checkBaseline = options.baselineOnFailure && checkBase && checkHead
    ? (check: { command: string }, remainingMs: number) => checkAtBaseline({ repoPath: options.repoPath, baseSha: checkBase, headSha: checkHead, command: check.command, timeoutMs: Math.max(remainingMs, 0) })
    : undefined;
  const checkRun = options.skipChecks ? undefined : runChecks(planned, { cwd: options.repoPath, timeoutMs: options.timeoutMs, tailBytes: options.tailBytes, baseline: checkBaseline });
  const checks = checkRun?.results.length ? checkRun.results : undefined;
  const failedCheck = checkRun?.failure?.check;
  // Checks that also fail at the base: still a failed verdict (required CI fails either way), but they
  // no longer stop the run before the change's own failures.
  const preexistingChecks = checkRun?.preexisting ?? [];
  const checksNote = preexistingChecks.length
    ? `; gate check(s) ${preexistingChecks.map((check) => check.id).join(", ")} also fail at the base commit (already broken before this change)`
    : "";
  // Every test run goes under a probe that records which `node --test` files started (selected ones must)
  // and each one's duration and result for the outcome log (2026-11-06). Outside node:test it does nothing.
  const expectedNodeTests = selection === "selected" && result ? selectedNodeTests(command, result.selectedTests) : [];
  const trace = !checkRun?.failure ? traceNodeTestFiles(options.repoPath) : undefined;
  let startedNodeTests: string[] | undefined;
  let execution: CommandMeasurement;
  try {
    execution = checkRun?.failure
      ? checkRun.failure.measurement
      : measureCommands(commands, { cwd: options.repoPath, timeoutMs: Math.max(options.timeoutMs - (checkRun?.wallMs ?? 0), 0), tailBytes: options.tailBytes, env: trace?.env, stopOnFailure: options.failFast });
    startedNodeTests = trace?.read();
    const nodeResults = trace?.results() ?? [];
    if (nodeResults.length) execution = { ...execution, testResults: mergeTestFileResults(execution.testResults, nodeResults) };
  } finally {
    trace?.dispose();
  }
  const failFastNote = execution.partsNotRun
    ? `; --fail-fast stopped at the first failing part, so ${execution.partsNotRun} later part(s) of the selection did not run`
    : "";
  const preexistingNote = checksNote + failFastNote;
  let after: WorkingTreeSnapshot;
  try {
    after = captureWorkingTreeSnapshot(options.repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...blocked(before, scope, `could not confirm the post-verification snapshot: ${message}`, analysis, counts, boundRange),
      selection,
      command,
      ...(commands.length > 1 ? { commands } : {}),
      execution,
      ...(checks ? { checks } : {}),
    };
  }

  // Tests often write fixtures, caches or generated files that .gitignore misses (2026-10-30: a quarter
  // of DentalPresence replays were blocked by them). A new file doesn't change what was verified, so
  // only a changed commit or a change to a file that existed before the run blocks the verdict.
  let changes: SnapshotChange[] = [];
  if (before.baseSha === after.baseSha) {
    try { changes = snapshotChanges(options.repoPath, before.treeSha, after.treeSha); }
    catch { changes = [{ path: "(snapshots could not be compared)", status: "modified" }]; }
  }
  const written = changes.filter((change) => change.status === "added").map((change) => change.path);
  const altered = changes.filter((change) => change.status !== "added");
  const unchanged = before.baseSha === after.baseSha && altered.length === 0;
  const testsPassed = !failedCheck && execution.exitCode === 0 && !execution.timedOut;
  const succeeded = testsPassed && preexistingChecks.length === 0;
  // Every selected file contributes at least one test (node:test) or test file (vitest, jest) to the
  // runner's summary; a smaller count means some selected tests never ran, which is not a pass.
  const selectedCount = selection === "selected" && result ? result.selectedTests.length : 0;
  // A count of 120 cannot show one missing file (2026-11-02); the probe's record of started files can.
  const unstarted = succeeded ? unstartedNodeTests(expectedNodeTests, startedNodeTests) : [];
  const undercounted = succeeded && execution.runnerTestCount !== undefined && execution.runnerTestCount < selectedCount;
  const unexecuted = unstarted.length > 0 || undercounted;
  const verification: VerificationStatus = !unchanged || unexecuted ? "blocked" : succeeded ? "passed" : "failed";
  const finalReason = !unchanged
    ? before.baseSha !== after.baseSha
      ? "HEAD moved while verification was running; rerun DiffCI for the new snapshot"
      : `the working tree changed while verification was running (${altered.slice(0, 5).map((change) => `${change.status} ${change.path}`).join(", ")}${altered.length > 5 ? `, ${altered.length - 5} more` : ""}); rerun DiffCI for the new snapshot`
    : unstarted.length
      ? `node --test never started ${unstarted.length} selected test file(s), such as ${unstarted[0]}, so the selection did not run as written; run the full test command instead`
    : unexecuted
      ? `the runner reported ${String(execution.runnerTestCount)} test(s) for ${selectedCount} selected test file(s), so some selected tests did not run; run the full test command instead`
    : succeeded
      ? checks ? `${reason}; ${checkSummary(checks)}` : reason
      : failedCheck
        ? `gate check ${failedCheck.id} ${failedCheck.status === "timed_out" ? "timed out" : `failed with exit code ${String(failedCheck.exit_code)}`}; tests were not run (${failedCheck.command})`
      : execution.timedOut
        ? `verification timed out after ${options.timeoutMs}ms${preexistingNote}`
        : testsPassed
          ? `${preexistingChecks.length} gate check(s) failed that also fail at the base commit; nothing this change introduced failed (${preexistingChecks.map((check) => check.id).join(", ")})`
          : `verification command failed with exit code ${String(execution.exitCode)}${preexistingNote}`;
  const baselineSha = scope === "commit-range" ? range?.baseSha : before.baseSha;
  const failureBaseline = verification === "failed" && !failedCheck && !execution.timedOut && options.baselineOnFailure && baselineSha
    ? compareWithBaseline({ repoPath: options.repoPath, baseSha: baselineSha, headSha: scope === "commit-range" ? before.baseSha : before.commitSha, commands, headFailures: execution.failingTests ?? [], timeoutMs: options.timeoutMs })
    : undefined;
  const baselineNote = failureBaseline && failureBaseline.status !== "unknown"
    ? `; ${failureBaseline.reason} (${failureBaseline.base_sha.slice(0, 12)})`
    : "";

  return {
    ...baseReport(before, scope, boundRange),
    verification,
    safe_to_continue: verification === "passed",
    reason: finalReason,
    changed_files: counts.changedFiles,
    tests_available: counts.testsAvailable,
    tests_selected: selection === "full" ? counts.testsAvailable : counts.testsSelected,
    ...(outsideSuite ? { tests_outside_full_suite: outsideSuite } : {}),
    selection,
    ...(selection === "selected" && result ? { selected_tests: result.selectedTests } : {}),
    ...(selection === "selected" && result?.selectionReasons ? { selection_reasons: result.selectionReasons } : {}),
    command,
    ...(commands.length > 1 ? { commands } : {}),
    execution,
    ...(checks ? { checks } : {}),
    snapshot: {
      ...baseReport(before, scope, boundRange).snapshot,
      after_base_sha: after.baseSha,
      after_tree_sha: after.treeSha,
      unchanged,
      ...(written.length ? { written_during_verification: written.slice(0, 20) } : {}),
      ...(altered.length ? { changed_during_verification: altered.slice(0, 20) } : {}),
    },
    analysis,
    required_actions: verification === "passed" ? [] : [finalReason + baselineNote],
    ...(failureBaseline ? { failure_baseline: failureBaseline } : {}),
  };
}

function stamped(report: VerificationReport, version: string): VerificationReport {
  const { schema, schema_version, produced_at, ...rest } = report;
  return { schema, schema_version, produced_at, diffci_version: version, ...rest };
}

/** Verify exactly the staged, unstaged, and non-ignored untracked content currently on disk. */
export async function verifyChanged(options: VerifyChangedOptions): Promise<VerificationReport> {
  return stamped(await verifyChangedSnapshot(options), options.version);
}

async function verifyChangedSnapshot(options: VerifyChangedOptions): Promise<VerificationReport> {
  const repoPath = resolve(options.repoPath);
  let before: WorkingTreeSnapshot;
  try {
    before = captureWorkingTreeSnapshot(repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocked(unknownSnapshot(), "working-tree", message, { status: "ERROR", stage: "context", fallback_reasons: [], error: message });
  }

  if (!before.changed) {
    return {
      ...baseReport(before, "working-tree"),
      verification: "passed",
      safe_to_continue: true,
      reason: "no staged, unstaged, or non-ignored untracked changes",
      changed_files: 0,
      tests_available: 0,
      tests_selected: 0,
      selection: "none",
      snapshot: {
        ...baseReport(before, "working-tree").snapshot,
        after_base_sha: before.baseSha,
        after_tree_sha: before.treeSha,
        unchanged: true,
      },
      analysis: { status: "not_needed", fallback_reasons: [] },
      required_actions: [],
    };
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "diffci-verify-"));
  try {
    const observation = await observe({
      repoPath,
      env: options.env,
      version: options.version,
      engineSha: options.engineSha,
      baseOverride: before.baseSha,
      headOverride: before.commitSha,
      redactPaths: options.redactPaths,
      reportPath: join(temporaryDirectory, "observation.json"),
      selectTestPhases: true,
    });
    return await executeObservation({ ...options, repoPath }, "working-tree", before, observation);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Verify a real commit range and bind the receipt to the clean commit that was actually executed. */
export async function verifyRange(options: VerifyRangeOptions): Promise<VerificationReport> {
  return stamped(await verifyCommitRange(options), options.version);
}

async function verifyCommitRange(options: VerifyRangeOptions): Promise<VerificationReport> {
  const repoPath = resolve(options.repoPath);
  let before: WorkingTreeSnapshot;
  try {
    before = captureWorkingTreeSnapshot(repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocked(unknownSnapshot(), "commit-range", message, { status: "ERROR", stage: "context", fallback_reasons: [], error: message });
  }
  if (before.changed) {
    return blocked(
      before,
      "commit-range",
      "commit-range verification requires a clean checkout; use verify --changed for uncommitted changes",
      { status: "not_needed", fallback_reasons: [] },
    );
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "diffci-verify-"));
  try {
    const observation = await observe({
      repoPath,
      env: options.env,
      version: options.version,
      engineSha: options.engineSha,
      baseOverride: options.baseOverride,
      headOverride: options.headOverride,
      redactPaths: options.redactPaths,
      reportPath: join(temporaryDirectory, "observation.json"),
      selectTestPhases: true,
    });
    return await executeObservation({ ...options, repoPath }, "commit-range", before, observation);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function checkSummary(checks: readonly CheckResult[]): string {
  const ran = checks.filter((check) => check.status === "passed").length;
  const narrowed = checks.filter((check) => check.status === "passed" && check.decision === "NARROWED").length;
  const skipped = checks.length - ran;
  return `ran ${ran} gate check(s) first${narrowed ? ` (${narrowed} narrowed to changed files)` : ""}${skipped ? `, skipped ${skipped} the change does not affect` : ""}`;
}

export function verificationExitCode(report: VerificationReport): number {
  if (report.verification === "passed") return 0;
  if (report.verification === "failed") return 1;
  return 2;
}

export function formatVerificationSummary(report: VerificationReport): string {
  const lines = [
    `DiffCI verification: ${report.verification.toUpperCase()}`,
    `  scope: ${report.scope}`,
    `  changed files: ${report.changed_files}`,
    `  verification: ${report.selection} (${report.tests_selected}/${report.tests_available} test files)`,
    `  reason: ${report.reason}`,
    `  snapshot: ${report.snapshot.before_tree_sha.slice(0, 12)} (${report.snapshot.unchanged ? "unchanged" : "not confirmed"})`,
  ];
  if (report.commit_range) lines.splice(2, 0, `  range: ${report.commit_range.base_sha.slice(0, 12)}..${report.commit_range.head_sha.slice(0, 12)}`);
  const written = report.snapshot.written_during_verification;
  if (written?.length) lines.push(`  written by the run (not in .gitignore): ${written.slice(0, 5).join(", ")}${written.length > 5 ? ", ..." : ""}`);
  if (report.checks) lines.push(`  checks: ${report.checks.map((check) => `${check.id} ${check.status}${check.baseline?.status === "preexisting" ? " (also fails at base)" : ""}`).join(", ")}`);
  if (report.command) lines.push(`  command: ${report.command}`);
  // A blocked push has to say what broke, not only that something did (2026-10-30 demo rehearsal: the
  // summary said "exit code 1" and nothing else).
  if (report.verification === "failed" && report.execution) {
    const failing = report.execution.failingTests ?? [];
    if (failing.length) lines.push(`  failing tests: ${failing.slice(0, 5).join(", ")}${failing.length > 5 ? `, ${failing.length - 5} more` : ""}`);
    const output = (report.execution.stderrTail.trim() ? report.execution.stderrTail : report.execution.stdoutTail)
      .split(/\r?\n/)
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
      .filter((line) => line.trim() && !/^\s+at /.test(line) && !/^Node\.js v/.test(line) && !/^ℹ /.test(line));
    if (output.length) lines.push("  output (last lines):", ...output.slice(-6).map((line) => `    ${line.slice(0, 200)}`));
  }
  if (report.enforcement) {
    const fired = report.enforcement.fired_fallback;
    lines.push(`  enforce: ${report.enforcement.applied ? "applied" : fired ? `fell back to full (${fired}: ${report.enforcement.detail})` : "not applied"}`);
  }
  return lines.join("\n");
}



function fullSelection(repoPath: string, reason: string) {
  const command = inferFullCommand(repoPath).command;
  return { selection: "full" as const, command, commands: command ? [command] : [], reason, outsideSuite: 0 };
}

/** The order to run selected tests in, and under --fail-fast the ones to run first (test-ranking.ts). */
export interface SelectedOrdering {
  order: readonly string[];
  first?: readonly string[];
}

/** Ranks the selected tests by the outcome log's history, or undefined when nothing in it says any is
 * likelier to fail than another, so a repository without history runs its selection exactly as before. */
function rankedOrdering(options: VerifyOptions, result: NonNullable<ObservationReport["result"]>): SelectedOrdering | undefined {
  if (options.rank === false || result.mode !== "SELECTIVE") return undefined;
  const path = outcomeLogPath(options.repoPath);
  const history = testHistory(path ? readOutcomes(path) : []);
  const reasons = result.selectionReasons ?? {};
  const likely = likelyFailures(result.selectedTests, history, reasons);
  if (likely.length === 0) return undefined;
  const order = rankTests(result.selectedTests, history, reasons);
  return { order, ...(options.failFast ? { first: order.filter((test) => likely.includes(test)) } : {}) };
}

/** The earlier pass in this repository's outcome log that covers this run, if any (reusablePass). */
function findReusablePass(options: VerifyOptions, treeSha: string, selection: "selected" | "full", selectedTests: readonly string[], command: string, planned: readonly PlannedCheck[]) {
  const path = outcomeLogPath(options.repoPath);
  if (!path) return undefined;
  return reusablePass(readOutcomes(path), {
    tree_sha: treeSha,
    diffci_version: options.version,
    node_version: process.versions.node,
    selection,
    selected_tests: selectedTests,
    command,
    full_command: selection === "full" ? command : fullSelection(options.repoPath, "").command,
    checks: planned.filter((check) => check.decision !== "SKIP").map(({ id, command: checkCommand }) => ({ id, command: checkCommand })),
  });
}

/** Shared executable plan for read-only agent selection and verification. */
export function executableSelection(repoPath: string, result: NonNullable<ObservationReport["result"]>, ordering?: SelectedOrdering) {
  let selection: "selected" | "full";
  let command: string | undefined;
  let reason: string;
  let primaryPhases: string[] = [];
  let selectedParts: string[] | undefined;
  const multiple = result.mode === "SELECTIVE" && !result.commandRefusalReason && result.proposedCommands.length > 1
    ? inferSelectedCommands(repoPath, result.proposedCommands, result.selectedTests) : undefined;
  if (multiple?.commands) {
    selection = "selected";
    selectedParts = multiple.commands;
    command = multiple.commands.join(" && ");
    primaryPhases = (result.testPhases ?? []).map(phaseCommand);
    reason = `dependency impact (${multiple.reason})${primaryPhases.length ? `; also ran ${primaryPhases.length} test-script phase(s) that read changed files: ${result.testPhases!.join("; ")}` : ""}`;
  } else if (multiple) {
    selection = "full";
    command = inferFullCommand(repoPath).command;
    reason = `selected verification was not executable (${multiple.reason}); broadened to full verification`;
  } else if (result.mode === "SELECTIVE" && !result.commandRefusalReason && result.proposedCommands.length === 1) {
    const inferred = inferSelectedCommand(repoPath, result.proposedCommands[0]!, result.selectedTests);
    // A selected file the runner's glob would not match never runs, and the rest still pass (2026-11-01).
    const unmatched = inferred.command ? unmatchedNodeTests(inferred.command, result.selectedTests) : [];
    const selected = unmatched.length
      ? { reason: `node --test would not match ${unmatched.length} selected test file(s), such as ${unmatched[0]}` }
      : inferred;
    const phases = result.testPhases ?? [];
    if (selected.command && phases.length) {
      // The selection covers some changed files only through these test-script phases, so they run
      // after the selected files, as the test script would run them (2026-10-28).
      selection = "selected";
      primaryPhases = phases.map(phaseCommand);
      command = selected.command;
      reason = `dependency impact; also ran ${phases.length} test-script phase(s) that read changed files: ${phases.join("; ")}`;
    } else if (selected.command) {
      selection = "selected";
      command = selected.command;
      reason = "dependency impact";
    } else {
      selection = "full";
      const full = inferFullCommand(repoPath);
      command = full.command;
      reason = `selected verification was not executable (${selected.reason}); broadened to full verification`;
    }
  } else {
    selection = "full";
    const full = inferFullCommand(repoPath);
    command = full.command;
    const fallback = result.fallbackReasons[0] ?? result.commandRefusalReason;
    reason = fallback ? `full verification required: ${fallback}` : "full verification required";
  }

  // Affected tests the full command never runs are still affected: run them after the selection
  // rather than counting them in it (2026-10-21).
  const outside = result.testsOutsideFullSuite ?? [];
  let outsideSuite = 0;
  let primary: string | undefined;
  let auxiliaryCommand: string | undefined;
  if (command && outside.length) {
    const auxiliary = result.outsideSuiteCommands?.length === 1 ? inferSelectedCommand(repoPath, result.outsideSuiteCommands[0]!, outside) : undefined;
    if (auxiliary?.command) {
      primary = command;
      auxiliaryCommand = auxiliary.command;
      command = `${command} && ${auxiliary.command}`;
      outsideSuite = outside.length;
      reason = `${reason}; also ran ${outside.length} affected test file(s) the full test command does not run`;
    } else {
      reason = `${reason}; ${outside.length} affected test file(s) outside the full test command were not run (${auxiliary?.reason ?? "no single command covers them"})`;
    }
  }

  // A single selected command runs its files likeliest failures first, and under --fail-fast as two
  // invocations, the likely ones and then the rest (test-ranking.ts, 2026-11-06).
  const single = selection === "selected" && !selectedParts && ordering ? primary ?? command : undefined;
  const ordered = single ? orderCommand(single, ordering!.order) : undefined;
  const primaryParts = ordered
    ? (ordering!.first?.length ? splitCommand(ordered, result.selectedTests, ordering!.first) : [ordered]).flatMap((part) => batchCommand(part, result.selectedTests))
    : undefined;
  // Each part stays within the shell's command-line limit (cmd.exe stops at 8,191 characters).
  const commands = command ? [
    ...(selectedParts ?? primaryParts ?? batchCommand(primary ?? command, selection === "selected" ? result.selectedTests : [])),
    ...primaryPhases,
    ...(auxiliaryCommand ? batchCommand(auxiliaryCommand, outside) : []),
  ] : [];
  return { selection, command: commands.length ? commands.join(" && ") : command, commands, reason, outsideSuite };
}

/** A test-script phase as a standalone command. `npm test` puts `node_modules/.bin` on PATH; outside
 * it a repository-local runner such as tsx is reached the way selected TypeScript tests are. */
export function phaseCommand(phase: string): string {
  return /^node\s/.test(phase) ? phase : `npx --no-install ${phase}`;
}
