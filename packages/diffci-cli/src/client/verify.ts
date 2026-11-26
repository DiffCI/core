import { createHash } from "node:crypto";
import { commandSpecToString, nodeTestGlobForPath } from "@diffci.com/core/planner/test-command";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DependencyGraphResult } from "@diffci.com/core/repo/types";

import { appendToCommand, batchCommand, measureCommands, orderCommand, splitCommand, subsetCommand } from "./command-batches.js";
import { coverageAdditions, readCoverageMap } from "./coverage-map.js";
import { checkAtBaseline, compareWithBaseline, type CheckBaseline, type FailureBaseline } from "./failure-baseline.js";
import { collectEnforcementContext, evaluateEnforcement, type EnforcementDecision } from "./enforce-policy.js";
import { inferFullCommand, inferPlannedCommands, inferSelectedCommand, inferSelectedCommands } from "./full-command.js";
import { canRunPythonSession, plannedChecks, runChecks, type CheckResult, type PlannedCheck } from "./gate-checks.js";
import { makeGitRunner, observe, separateProjectReason } from "./observe.js";
import { redactPath, type ObservationCommitRange, type ObservationReport, type SelectionReason } from "./report.js";
import { createIsolatedWorktree } from "./isolated-worktree.js";
import { selectedNodeTests, traceNodeTestFiles, unmatchedNodeTests, unstartedNodeTests } from "./selected-coverage.js";
import { outcomeLogPath, readOutcomes, reusablePass } from "./outcome-log.js";
import { likelyFailures, rankTests, testHistory } from "./test-ranking.js";
import { assignShards, type ShardSpec, type TimingsFile } from "./test-shards.js";
import { mergeTestFileResults } from "./test-results.js";
import type { CommandMeasurement } from "./verify-savings.js";
import { captureScopedTree, captureWorkingTreeSnapshot, snapshotChanges, type SnapshotChange, type VerificationTreeScope, type WorkingTreeSnapshot } from "./working-tree.js";

export const VERIFICATION_SCHEMA = "diffci.verification.v1" as const;

export type VerificationStatus = "passed" | "failed" | "blocked";
/** `staged` and `paths` (2026-11-17) verify HEAD plus only the index, or only the named files, in a temporary worktree. */
export type VerificationScope = "working-tree" | "commit-range" | "staged" | "paths";

/** What a `staged` or `paths` receipt covered, and what in the checkout it left out (verifyScoped). */
export interface ScopedVerification {
  kind: "staged" | "paths";
  /** Always a temporary worktree of HEAD plus the verified files. */
  isolation: "temporary-worktree";
  /** Files that differ from HEAD in the verified tree (digests under --redact-paths). */
  verified_files: string[];
  /** Files in the checkout that differ from the verified tree: other work left out, verified at HEAD. */
  excluded_dirty_files: number;
  /** The first 50 of them. */
  excluded_dirty_paths: string[];
  /** Verified files that import an excluded dirty file, which was verified at its HEAD version. */
  head_version_imports?: Array<{ file: string; imports: string[] }>;
  /** Set when the temporary worktree could not be removed; `git worktree prune` after deleting it. */
  cleanup_failed?: string;
}

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
    /** Checked-out files left out of the snapshot because they differ from HEAD only by CRLF line endings, at most 20. */
    line_ending_only_changes?: string[];
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
    /** Why graph_confidence is below COMPLETE, in counts only. */
    graph_confidence_reasons?: string[];
  };
  required_actions: string[];
  /** Present when a failed verification was rerun at the base commit (`--baseline-on-failure`). */
  failure_baseline?: FailureBaseline;
  /** Present only under `--policy enforce`. `applied` is true when the selected tests replaced the full suite. */
  enforcement?: EnforcementDecision & { applied: boolean };
  /** Present when nothing ran because an earlier pass of this exact tree covered it (outcome-log.ts, reusablePass). */
  reused_from?: { produced_at: string; selection: "selected" | "full"; command?: string };
  /** Present under `--shard i/N`: this job's share of the selection (test-shards.ts). */
  shard?: { index: number; total: number; timings: "file" | "equal" };
  /** A full run that first ran the tests the dependency graph found affected (firstPassParts). */
  first_pass?: { tests: number; commands: string[]; stopped_full_suite: boolean };
  /** Tests the coverage map added to the selection (coverage-map.ts), when it added any. */
  coverage_added?: string[];
  /** Present for `--staged` and `--paths`: the verified files and the excluded dirty ones. */
  scoped?: ScopedVerification;
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
  /** Run only this job's share of the selection (`--shard i/N`), balanced by `timings` when given. */
  shard?: ShardSpec;
  timings?: TimingsFile;
  /** False ignores the coverage map (`--no-coverage`). */
  coverage?: boolean;
  /** Receives the dependency graph the analysis built (verifyScoped reads its edges). */
  onGraph?: (result: DependencyGraphResult) => void;
}

export interface VerifyChangedOptions extends VerifyOptions {}

export interface VerifyScopedOptions extends VerifyOptions {
  scope: VerificationTreeScope;
}

export interface VerifyRangeOptions extends VerifyOptions {
  baseOverride?: string;
  headOverride?: string;
  /** Opt-in enforce mode (docs/enforce-mode-01-plan.md). Absent means today's behaviour, unchanged. */
  policy?: "enforce";
  /** Internal: this run is already inside the temporary worktree of a dirty checkout. */
  isolated?: boolean;
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
      ...(snapshot.lineEndingOnly ? { line_ending_only_changes: snapshot.lineEndingOnly.slice(0, 20) } : {}),
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
  // The analysis sees real paths, but under --redact-paths enforce keeps treating the paths as redacted.
  const context = options.policy === "enforce" ? collectEnforcementContext(makeGitRunner(options.repoPath), options.env, observation) : undefined;
  const enforcement = context
    ? evaluateEnforcement(options.redactPaths ? { ...context, pathsRedacted: true } : context, observation)
    : undefined;
  const executed = await executeWithPolicy(options, scope, before, observation, enforcement);
  const report = options.redactPaths ? redactReceipt(executed, observation.result, options.repoPath) : executed;
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
  // Under --shard, narrowed to this job's share once the commands are built.
  let result = observation.result;
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
    ...(result?.graph ? { graph_confidence: result.graph.confidence, effective_graph_confidence: result.graph.effectiveConfidence, ...(result.graph.confidenceReasons?.length ? { graph_confidence_reasons: result.graph.confidenceReasons } : {}) } : {}),
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

  // Coverage edges, phase A (coverage-map.ts, 2026-11-06): tests the coverage map connects to a changed
  // file and the graph did not select are added. Only ever adds; a selected command that cannot take them
  // runs the full suite instead. Never under enforce or path redaction.
  const coverageAdded: string[] = [];
  if (result && result.mode === "SELECTIVE" && !enforcement && !options.redactPaths && options.coverage !== false) {
    const map = readCoverageMap(options.repoPath);
    const additions = map ? coverageAdditions(map, result.changedFiles, result.selectedTests) : [];
    if (additions.length) {
      const tests = additions.map((addition) => addition.test);
      const extended = result.proposedCommands.length === 1 ? appendToCommand(result.proposedCommands[0]!, result.selectedTests, tests) : undefined;
      coverageAdded.push(...tests);
      result = extended
        ? {
            ...result,
            selectedTests: [...result.selectedTests, ...tests],
            proposedCommands: [extended],
            selectionReasons: { ...result.selectionReasons, ...Object.fromEntries(additions.map((addition) => [addition.test, { reason: "COVERAGE", changed_file: addition.changed_file }])) },
          }
        : { ...result, mode: "FULL", fallbackReasons: [...result.fallbackReasons, `the coverage map adds ${tests.length} test file(s) the selected command cannot include, such as ${tests[0]}`] };
      counts.testsSelected = result.selectedTests.length;
      analysis.fallback_reasons = result.fallbackReasons;
    }
  }

  // --shard i/N (test-shards.ts): this job's share of the selection, split the same way in every job.
  const shard = options.shard;
  const shardTests = shard && result && !enforcedFull && result.mode === "SELECTIVE"
    ? assignShards(result.selectedTests, shard.total, options.timings)[shard.index - 1]!
    : undefined;
  const executable = enforcedFull || !result
    ? fullSelection(options.repoPath, `enforce fallback (${enforcement?.fired_fallback}): ${enforcement?.detail}`)
    : executableSelection(options.repoPath, result, rankedOrdering(options, result), shard && shardTests ? { tests: new Set(shardTests), first: shard.index === 1 } : undefined);
  const { selection, command, commands, outsideSuite } = executable;
  // A full run first runs the tests the graph did find, and stops if one fails (2026-11-06 LobeHub catch
  // study: both test-only failures were lost when the full suite reached the time limit first).
  const firstPass = selection === "full" && !enforcedFull && !shard && !options.redactPaths && result ? firstPassParts(options.repoPath, result) : undefined;
  const runCommands = firstPass ? [...firstPass.parts, ...commands] : commands;
  const reason = coverageAdded.length && selection === "selected"
    ? `${executable.reason}; the coverage map added ${coverageAdded.length} test file(s) the dependency graph did not select (${coverageAdded.slice(0, 3).join(", ")})`
    : executable.reason;
  const coverageField = coverageAdded.length && selection === "selected" ? { coverage_added: coverageAdded } : {};
  const unshardable = "unshardable" in executable && executable.unshardable;
  const shardField = shard ? { shard: { index: shard.index, total: shard.total, timings: options.timings ? "file" as const : "equal" as const } } : {};
  if (shard) {
    const label = `${shard.index}/${shard.total}`;
    const elsewhere = selection === "full" ? `the full suite runs in shard 1/${shard.total}`
      : unshardable ? `the selected command cannot be split, so the whole selection runs in shard 1/${shard.total}`
      : undefined;
    if ((elsewhere && shard.index !== 1) || commands.length === 0) {
      const why = elsewhere && shard.index !== 1 ? elsewhere : `shard ${label} has no selected test files`;
      return {
        ...baseReport(before, scope, boundRange),
        verification: "passed",
        safe_to_continue: true,
        reason: `nothing to run in shard ${label}: ${why}`,
        changed_files: counts.changedFiles,
        tests_available: counts.testsAvailable,
        tests_selected: 0,
        selection: "none",
        snapshot: { ...baseReport(before, scope, boundRange).snapshot, after_base_sha: before.baseSha, after_tree_sha: before.treeSha, unchanged: true },
        analysis,
        required_actions: [],
        ...shardField,
      };
    }
    if (selection === "selected" && !unshardable && shardTests && result) {
      const reasons = result.selectionReasons;
      result = { ...result, selectedTests: shardTests, ...(reasons ? { selectionReasons: Object.fromEntries(shardTests.flatMap((test) => reasons[test] ? [[test, reasons[test]!]] : [])) } : {}) };
      counts.testsSelected = shardTests.length;
    }
  }

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
      ...shardField,
      ...coverageField,
    };
  }
  const checkBaseline = options.baselineOnFailure && checkBase && checkHead
    // With no time left the base rerun would get a 0ms limit, which means none: report it as unknown instead.
    ? (check: { command: string }, remainingMs: number): CheckBaseline => remainingMs <= 0
      ? { status: "unknown", base_sha: checkBase, reason: "the time limit ran out before the base run" }
      : checkAtBaseline({ repoPath: options.repoPath, baseSha: checkBase, headSha: checkHead, command: check.command,
        timeoutMs: remainingMs, canRunSession: canRunPythonSession })
    : undefined;
  const checkRun = options.skipChecks ? undefined : runChecks(planned, { cwd: options.repoPath, timeoutMs: options.timeoutMs, tailBytes: options.tailBytes, baseline: checkBaseline });
  const checks = checkRun?.results.length ? checkRun.results : undefined;
  const failedCheck = checkRun?.failure?.check;
  // Checks the time limit left no room for were never run, so the tests must not run (with no limit) either.
  const unrunChecks = checkRun?.outOfTime ? checkRun.results.filter((check) => check.status === "not_run") : [];
  // Every check can run and still use the whole budget (a slow last check, or a base rerun after a
  // failure that also fails at the base). The tests would then get a 0ms limit, which means none.
  const testBudgetMs = options.timeoutMs - (checkRun?.wallMs ?? 0);
  const budgetUsedByChecks = Boolean(checkRun && !checkRun.failure && !unrunChecks.length && testBudgetMs <= 0
    && checkRun.results.some((check) => check.status !== "skipped" && check.status !== "not_run"));
  const testsOutOfTime = unrunChecks.length > 0 || budgetUsedByChecks;
  // Checks that also fail at the base: still a failed verdict (required CI fails either way), but they
  // no longer stop the run before the change's own failures.
  const preexistingChecks = checkRun?.preexisting ?? [];
  const checksNote = preexistingChecks.length
    ? `; gate check(s) ${preexistingChecks.map((check) => check.id).join(", ")} also fail at the base commit (already broken before this change)`
    : "";
  // Every test run goes under a probe that records which `node --test` files started (selected ones must)
  // and each one's duration and result for the outcome log (2026-11-06). Outside node:test it does nothing.
  const expectedNodeTests = selection === "selected" && result ? selectedNodeTests(command, result.selectedTests) : [];
  const trace = !checkRun?.failure && !testsOutOfTime ? traceNodeTestFiles(options.repoPath) : undefined;
  let startedNodeTests: string[] | undefined;
  let execution: CommandMeasurement;
  try {
    execution = checkRun?.failure
      ? checkRun.failure.measurement
      : testsOutOfTime
      ? checksOutOfTime(command, checkRun?.wallMs ?? 0)
      : measureCommands(runCommands, { cwd: options.repoPath, timeoutMs: testBudgetMs, tailBytes: options.tailBytes, env: trace?.env, stopOnFailure: options.failFast, stopOnFailureWithin: firstPass?.parts.length });
    startedNodeTests = trace?.read();
    const nodeResults = trace?.results() ?? [];
    if (nodeResults.length) execution = { ...execution, testResults: mergeTestFileResults(execution.testResults, nodeResults) };
  } finally {
    trace?.dispose();
  }
  const stoppedInFirstPass = firstPass && execution.partsNotRun !== undefined && runCommands.length - execution.partsNotRun <= firstPass.parts.length;
  const failFastNote = stoppedInFirstPass
    ? `; ${firstPass.tests} test file(s) the dependency graph found affected ran before the full suite and failed, so the full suite was not run`
    : execution.partsNotRun
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
      : unrunChecks.length
        ? `gate check(s) ${unrunChecks.map((check) => check.id).join(", ")} did not run within the ${options.timeoutMs}ms time limit; tests were not run`
      : budgetUsedByChecks
        ? `gate checks used the whole ${options.timeoutMs}ms time limit (${String(checkRun?.wallMs ?? 0)}ms); tests were not run`
      : failedCheck
        ? `gate check ${failedCheck.id} ${failedCheck.status === "timed_out" ? "timed out" : `failed with exit code ${String(failedCheck.exit_code)}`}; tests were not run (${failedCheck.command})`
      : execution.timedOut
        ? `verification timed out after ${options.timeoutMs}ms${preexistingNote}`
        : testsPassed
          ? `${preexistingChecks.length} gate check(s) failed that also fail at the base commit; nothing this change introduced failed (${preexistingChecks.map((check) => check.id).join(", ")})`
          : `verification command failed with exit code ${String(execution.exitCode)}${preexistingNote}`;
  const baselineSha = scope === "commit-range" ? range?.baseSha : before.baseSha;
  const failureBaseline = verification === "failed" && !failedCheck && !testsOutOfTime && !execution.timedOut && options.baselineOnFailure && baselineSha
    // The base reruns only the parts that ran here: a first-pass failure is compared without the full suite.
    ? compareWithBaseline({ repoPath: options.repoPath, baseSha: baselineSha, headSha: scope === "commit-range" ? before.baseSha : before.commitSha, commands: stoppedInFirstPass ? firstPass.parts : commands, headFailures: execution.failingTests ?? [], timeoutMs: options.timeoutMs })
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
    command: firstPass ? runCommands.join(" && ") : command,
    ...(runCommands.length > 1 ? { commands: runCommands } : {}),
    ...(firstPass ? { first_pass: { tests: firstPass.tests, commands: firstPass.parts, stopped_full_suite: Boolean(stoppedInFirstPass) } } : {}),
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
    ...shardField,
    ...coverageField,
  };
}

function stamped(report: VerificationReport, version: string, redactPaths: boolean | undefined): VerificationReport {
  const { schema, schema_version, produced_at, ...rest } = report;
  return { schema, schema_version, produced_at, diffci_version: version, ...rest, ...(redactPaths ? { snapshot: redactSnapshot(report.snapshot) } : {}) };
}

/** Verify exactly the staged, unstaged, and non-ignored untracked content currently on disk. */
export async function verifyChanged(options: VerifyChangedOptions): Promise<VerificationReport> {
  return stamped(await verifyChangedSnapshot(options), options.version, options.redactPaths);
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
      // Planned with real paths so the selected tests can run; only the receipt is redacted (redactReceipt).
      reportPath: join(temporaryDirectory, "observation.json"),
      selectTestPhases: true,
      ...(options.onGraph ? { onGraph: options.onGraph } : {}),
    });
    return await executeObservation({ ...options, repoPath }, "working-tree", before, observation);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Verify HEAD plus only the staged content (`--staged`) or only the named files (`--paths`), 2026-11-17.
 *
 * The scoped tree is checked out in a temporary worktree of HEAD (isolated-worktree.ts) and verified
 * there exactly as `--changed` verifies a checkout, so every other uncommitted file in this checkout is
 * at its HEAD version for analysis and for the tests: it can neither fail nor rescue the result. The
 * receipt names the verified files and the excluded dirty ones. Its tree is the tree a commit of the
 * staged files has, so the pre-push hook reuses a pass of it (outcome-log.ts, reusablePass).
 */
/** The scoped tree, the files it changes from HEAD, and the checkout's other changed files (excluded). */
export function scopedChanges(repoPath: string, scope: VerificationTreeScope): { scoped: WorkingTreeSnapshot; verified: SnapshotChange[]; excluded: SnapshotChange[] } {
  const scoped = captureScopedTree(repoPath, scope);
  const checkout = captureWorkingTreeSnapshot(repoPath);
  return {
    scoped,
    verified: snapshotChanges(repoPath, `${scoped.baseSha}^{tree}`, scoped.treeSha),
    excluded: snapshotChanges(repoPath, scoped.treeSha, checkout.treeSha),
  };
}

export async function verifyScoped(options: VerifyScopedOptions): Promise<VerificationReport> {
  return stamped(await verifyScopedTree(options), options.version, options.redactPaths);
}

async function verifyScopedTree(options: VerifyScopedOptions): Promise<VerificationReport> {
  const repoPath = resolve(options.repoPath);
  const kind = options.scope.kind;
  const shown = (path: string) => options.redactPaths ? redactPath(path, (input) => createHash("sha256").update(input).digest("hex")) : path;
  let scoped: WorkingTreeSnapshot;
  let verified: SnapshotChange[];
  let excluded: SnapshotChange[];
  try {
    ({ scoped, verified, excluded } = scopedChanges(repoPath, options.scope));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocked(unknownSnapshot(), kind, message, { status: "ERROR", stage: "context", fallback_reasons: [], error: message });
  }
  const scopedField: ScopedVerification = {
    kind,
    isolation: "temporary-worktree",
    verified_files: verified.map((change) => shown(change.path)),
    excluded_dirty_files: excluded.length,
    excluded_dirty_paths: excluded.slice(0, 50).map((change) => shown(change.path)),
  };

  if (!scoped.changed) {
    return {
      ...baseReport(scoped, kind),
      verification: "passed",
      safe_to_continue: true,
      reason: kind === "staged" ? "nothing is staged: the index matches HEAD" : "the given paths do not differ from HEAD",
      changed_files: 0,
      tests_available: 0,
      tests_selected: 0,
      selection: "none",
      snapshot: { ...baseReport(scoped, kind).snapshot, after_base_sha: scoped.baseSha, after_tree_sha: scoped.treeSha, unchanged: true },
      analysis: { status: "not_needed", fallback_reasons: [] },
      required_actions: [],
      scoped: scopedField,
    };
  }

  const worktree = createIsolatedWorktree(repoPath, scoped.baseSha, scoped.treeSha);
  if ("error" in worktree) {
    return { ...blocked(scoped, kind, worktree.error, { status: "not_needed", fallback_reasons: [] }, { changedFiles: verified.length }), scoped: scopedField };
  }
  let forward: Record<string, string[]> | undefined;
  let inner: VerificationReport;
  let cleaned: boolean;
  try {
    inner = await verifyChangedSnapshot({ ...options, repoPath: worktree.path, onGraph: (graph) => { forward = graph.graph.forward; } });
  } finally {
    cleaned = worktree.dispose();
  }
  if (!cleaned) scopedField.cleanup_failed = worktree.path;

  // Excluded dirty files a verified file imports were verified at their HEAD version: say which.
  const excludedPaths = new Set(excluded.map((change) => change.path));
  const imports = forward
    ? verified.flatMap((change) => {
        const targets = (forward![change.path] ?? []).filter((target) => excludedPaths.has(target));
        return targets.length ? [{ file: shown(change.path), imports: [...new Set(targets)].sort().map(shown) }] : [];
      })
    : [];
  if (imports.length) scopedField.head_version_imports = imports;

  // The verdict is for the tree captured at the start: HEAD and the scoped files must still be it.
  let after: WorkingTreeSnapshot | undefined;
  try { after = captureScopedTree(repoPath, options.scope); } catch { after = undefined; }
  const moved = !after ? "could not re-read the verified files after the run"
    : after.baseSha !== scoped.baseSha ? "HEAD moved while verification was running"
    : after.treeSha !== scoped.treeSha ? (kind === "staged" ? "the index changed while verification was running (another session may have staged files)" : "the given files changed while verification was running")
    : inner.snapshot.before_tree_sha !== scoped.treeSha ? "the temporary worktree did not reproduce the verified files"
    : undefined;
  const importNote = imports.length
    ? `; ${imports.length} verified file(s) import files changed outside the scope, verified at their HEAD version (${imports.slice(0, 3).map((entry) => `${entry.file} -> ${entry.imports.join(", ")}`).join("; ")})`
    : "";
  const report: VerificationReport = { ...inner, scope: kind, reason: `${inner.reason}${importNote}`, scoped: scopedField };
  if (moved) {
    const reason = `${moved}; rerun DiffCI for the new ${kind === "staged" ? "index" : "files"}`;
    return { ...report, verification: "blocked", safe_to_continue: false, reason, required_actions: [reason] };
  }
  return report;
}

/** Verify a real commit range and bind the receipt to the clean commit that was actually executed. */
export async function verifyRange(options: VerifyRangeOptions): Promise<VerificationReport> {
  return stamped(await verifyCommitRange(options), options.version, options.redactPaths);
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
  // A checkout that differs from HEAD only by CRLF line endings is clean: the snapshot leaves those files out.
  if (before.changed && !options.isolated) return verifyRangeIsolated(options, repoPath, before);
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
      // Planned with real paths so the selected tests can run; only the receipt is redacted (redactReceipt).
      reportPath: join(temporaryDirectory, "observation.json"),
      selectTestPhases: true,
    });
    return await executeObservation({ ...options, repoPath }, "commit-range", before, observation);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Commit-range verification in a dirty checkout (2026-11-23).
 *
 * WHY. A range verifies commits, so uncommitted files cannot be part of it, yet they blocked it outright:
 * agent sessions sharing one DentalPresence checkout leave untracked and edited files behind, and the
 * pre-push hook's own clean check races them (a file written between its `git status` and DiffCI's
 * snapshot), so pushes went out unverified.
 *
 * WHAT. The head commit is checked out in a temporary worktree (isolated-worktree.ts, as --staged and
 * --paths do) and the range is verified there, where the checkout is clean by construction. Installed
 * dependencies are linked in only when the head's lockfiles match this checkout's; otherwise the run says
 * it cannot verify, as before. The uncommitted files are neither verified nor touched.
 */
async function verifyRangeIsolated(options: VerifyRangeOptions, repoPath: string, before: WorkingTreeSnapshot): Promise<VerificationReport> {
  const git = makeGitRunner(repoPath);
  const resolved = git(["rev-parse", "--verify", `${options.headOverride ?? before.baseSha}^{commit}`]);
  const treeResult = resolved.ok ? git(["rev-parse", "--verify", `${resolved.stdout.trim()}^{tree}`]) : resolved;
  if (!resolved.ok || !treeResult.ok) {
    const message = !treeResult.ok ? treeResult.error : "could not resolve the head commit";
    return blocked(before, "commit-range", `could not resolve the head commit to verify it apart from this checkout's uncommitted changes: ${message}`, { status: "ERROR", stage: "context", fallback_reasons: [], error: message });
  }
  const head = resolved.stdout.trim();
  const tree = treeResult.stdout.trim();
  const worktree = createIsolatedWorktree(repoPath, head, tree);
  if ("error" in worktree) {
    return blocked(before, "commit-range", `this checkout has uncommitted changes, and verifying ${head.slice(0, 12)} apart from them failed: ${worktree.error}`, { status: "not_needed", fallback_reasons: [] });
  }
  let inner: VerificationReport;
  try {
    // The worktree's HEAD is the head commit, so the range resolves there exactly as it would have here.
    inner = await verifyCommitRange({ ...options, repoPath: worktree.path, isolated: true });
  } finally {
    worktree.dispose();
  }
  const note = `verified in a clean temporary worktree of ${head.slice(0, 12)}; this checkout's uncommitted changes were not part of it`;
  return { ...inner, reason: inner.reason ? `${inner.reason}; ${note}` : note };
}

/**
 * Under --redact-paths the analysis plans with real paths, so the selected tests can run, and the receipt
 * carries digests instead (the same sha256-12 as the observation report): the selected tests and their
 * reasons, and those paths wherever the command and reason text name them. The text also names the files
 * the snapshot lists (a file the run changed); `stamped` digests the lists themselves (redactSnapshot).
 */
function redactReceipt(report: VerificationReport, result: ObservationReport["result"], repoPath: string): VerificationReport {
  const digest = (path: string) => redactPath(path, (input) => createHash("sha256").update(input).digest("hex"));
  const snapshot = report.snapshot;
  const known = [...new Set([
    ...(result?.selectedTests ?? []), ...(result?.testsOutsideFullSuite ?? []), ...(result?.changedFiles ?? []),
    ...(snapshot.written_during_verification ?? []), ...(snapshot.changed_during_verification ?? []).map((change) => change.path),
    ...(snapshot.line_ending_only_changes ?? []),
  ])].filter((path) => path.length > 0);
  // A command names a path as written, or as the `node --test` glob that matches only it, either one
  // shell-escaped when it holds glob characters: `d[1].test.js` runs as "d@([[])1@([]]).test.js".
  const shellForm = (text: string) => commandSpecToString({ executable: "", args: [text] }).slice(1);
  const forms = known.flatMap((path) => {
    const glob = nodeTestGlobForPath(path);
    return [...new Set([path, shellForm(path), ...(glob ? [glob, shellForm(glob)] : [])])].map((form) => [form, digest(path)] as const);
  });
  // The outside-suite reason names the separate project's directory, which is no file the run knows.
  const outside = result?.testsOutsideFullSuite ?? [];
  const projectReason = outside.length ? separateProjectReason(repoPath, outside) : undefined;
  if (projectReason) forms.push([projectReason, separateProjectReason(repoPath, outside, digest)!]);
  forms.sort((left, right) => right[0].length - left[0].length);
  const scrub = (text: string) => forms.reduce((current, [form, hidden]) => current.split(form).join(hidden), text);
  return {
    ...report,
    reason: scrub(report.reason),
    required_actions: report.required_actions.map(scrub),
    ...(report.selected_tests ? { selected_tests: report.selected_tests.map(digest) } : {}),
    ...(report.selection_reasons ? {
      selection_reasons: Object.fromEntries(Object.entries(report.selection_reasons).map(([test, why]) => [digest(test), { ...why, changed_file: digest(why.changed_file) }])),
    } : {}),
    ...(report.command !== undefined ? { command: scrub(report.command) } : {}),
    ...(report.commands ? { commands: report.commands.map(scrub) } : {}),
    ...(report.first_pass ? { first_pass: { ...report.first_pass, commands: report.first_pass.commands.map(scrub) } } : {}),
    ...(report.execution ? { execution: redactMeasurement(report.execution, scrub) } : {}),
    // Gate checks name the changed files in their reasons, and a NARROWED check's command lists them.
    ...(report.checks ? { checks: report.checks.map((check) => ({ ...check, command: scrub(check.command), reason: scrub(check.reason) })) } : {}),
    ...(report.failure_baseline ? {
      failure_baseline: {
        ...report.failure_baseline,
        reason: scrub(report.failure_baseline.reason),
        preexisting: report.failure_baseline.preexisting.map(scrub),
        introduced: report.failure_baseline.introduced.map(scrub),
      },
    } : {}),
  };
}

/**
 * The snapshot's file lists under --redact-paths: the files the run wrote or changed, and the files that
 * differ only by line endings. Applied to every receipt, including the ones that return before the run.
 */
function redactSnapshot(snapshot: VerificationReport["snapshot"]): VerificationReport["snapshot"] {
  const digest = (path: string) => redactPath(path, (input) => createHash("sha256").update(input).digest("hex"));
  return {
    ...snapshot,
    ...(snapshot.written_during_verification ? { written_during_verification: snapshot.written_during_verification.map(digest) } : {}),
    ...(snapshot.changed_during_verification ? { changed_during_verification: snapshot.changed_during_verification.map((change) => ({ ...change, path: digest(change.path) })) } : {}),
    ...(snapshot.line_ending_only_changes ? { line_ending_only_changes: snapshot.line_ending_only_changes.map(digest) } : {}),
  };
}

/** The run's command, output tails, failing test names and per-file results, with the known paths as digests. */
function redactMeasurement(execution: CommandMeasurement, scrub: (text: string) => string): CommandMeasurement {
  return {
    ...execution,
    command: scrub(execution.command),
    stdoutTail: scrub(execution.stdoutTail),
    stderrTail: scrub(execution.stderrTail),
    ...(execution.failingTests ? { failingTests: execution.failingTests.map(scrub) } : {}),
    ...(execution.testResults ? { testResults: execution.testResults.map((result) => ({ ...result, file: scrub(result.file) })) } : {}),
  };
}

function checkSummary(checks: readonly CheckResult[]): string {
  const ran = checks.filter((check) => check.status === "passed").length;
  const narrowed = checks.filter((check) => check.status === "passed" && check.decision === "NARROWED").length;
  const skipped = checks.length - ran;
  return `ran ${ran} gate check(s) first${narrowed ? ` (${narrowed} narrowed to changed files)` : ""}${skipped ? `, skipped ${skipped} the change does not affect` : ""}`;
}

/** The measurement recorded when the time limit ran out during the gate checks, before the tests started. */
function checksOutOfTime(command: string, wallMs: number): CommandMeasurement {
  const now = new Date().toISOString();
  return { command, exitCode: null, signal: null, timedOut: true, startedAt: now, finishedAt: now, wallMs: 0, stdoutTail: "", stderrTail: `gate checks used the time limit (${wallMs}ms); tests were not run` };
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
  const scoped = report.scoped;
  if (scoped) {
    const list = (paths: readonly string[], total: number) => `${paths.slice(0, 5).join(", ")}${total > 5 ? `, ${total - 5} more` : ""}`;
    lines.splice(2, 0, `  verified files (HEAD + ${scoped.kind === "staged" ? "index" : "given paths"}, temporary worktree): ${scoped.verified_files.length}${scoped.verified_files.length ? ` (${list(scoped.verified_files, scoped.verified_files.length)})` : ""}`);
    if (scoped.excluded_dirty_files) lines.splice(3, 0, `  excluded: ${scoped.excluded_dirty_files} other changed file(s) in this checkout, verified at HEAD (${list(scoped.excluded_dirty_paths, scoped.excluded_dirty_files)})`);
    if (scoped.cleanup_failed) lines.push(`  warning: could not remove the temporary worktree ${scoped.cleanup_failed}; delete it and run git worktree prune`);
  }
  const lineEndings = report.snapshot.line_ending_only_changes;
  if (lineEndings?.length) {
    lines.push(`  line endings only: ${lineEndings.length}${lineEndings.length === 20 ? "+" : ""} checked-out file(s) differ from HEAD only by CRLF (${lineEndings.slice(0, 3).join(", ")}${lineEndings.length > 3 ? ", ..." : ""}); verified as checked out`);
  }
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

/**
 * The commands that run a FULL observation's affected tests on their own, before the full suite: the
 * tests the dependency graph did find, which a fallback elsewhere in the change does not make less
 * likely to fail. Only when they are under half the suite, so the extra pass stays small, and only when
 * the planner can run every one of them (paths are not redacted).
 */
export function firstPassParts(repoPath: string, result: NonNullable<ObservationReport["result"]>): { parts: string[]; tests: number } | undefined {
  const tests = result.selectedTests;
  if (result.mode !== "FULL" || tests.length === 0 || !(tests.length * 2 < result.totalTestCount)) return undefined;
  const planned = inferPlannedCommands(repoPath, tests);
  if (!planned) return undefined;
  if ("commands" in planned) return { parts: planned.commands, tests: tests.length };
  // A selected file the runner's glob would not match never runs (as executableSelection checks).
  if (unmatchedNodeTests(planned.single, tests).length) return undefined;
  return { parts: batchCommand(planned.single, tests), tests: tests.length };
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
export function executableSelection(repoPath: string, result: NonNullable<ObservationReport["result"]>, ordering?: SelectedOrdering, shard?: { tests: ReadonlySet<string>; first: boolean }) {
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
      reason = `${reason}; ${outside.length} affected test file(s) outside the full test command were not run (${auxiliary?.reason ?? result.outsideSuiteRefusalReason ?? "no single command covers them"})`;
    }
  }

  // Under --shard each selected command keeps only the shard's files, and the test-script phases and the
  // outside-suite command run in shard 1 (test-shards.ts, 2026-11-06). A command that cannot be cut
  // safely leaves the whole selection to shard 1.
  let shardParts: string[] | undefined;
  let unshardable = false;
  if (shard && selection === "selected" && command) {
    const cut = (selectedParts ?? [primary ?? command]).map((part) => subsetCommand(part, result.selectedTests, shard.tests));
    if (cut.some((part) => part === undefined)) unshardable = true;
    else shardParts = cut.filter((part): part is string => typeof part === "string");
  }
  // A single selected command runs its files likeliest failures first, and under --fail-fast as two
  // invocations, the likely ones and then the rest (test-ranking.ts, 2026-11-06).
  const singleSource = shardParts ? (shardParts.length === 1 ? shardParts[0] : undefined) : primary ?? command;
  const single = selection === "selected" && !selectedParts && ordering ? singleSource : undefined;
  const ordered = single ? orderCommand(single, ordering!.order) : undefined;
  const primaryParts = ordered
    ? (ordering!.first?.length ? splitCommand(ordered, result.selectedTests, ordering!.first) : [ordered]).flatMap((part) => batchCommand(part, result.selectedTests))
    : undefined;
  const extras = !shard || shard.first || unshardable ? [...primaryPhases, ...(auxiliaryCommand ? batchCommand(auxiliaryCommand, outside) : [])] : [];
  // Each part stays within the shell's command-line limit (cmd.exe stops at 8,191 characters).
  const commands = command ? [
    ...(primaryParts ?? shardParts?.flatMap((part) => batchCommand(part, result.selectedTests)) ?? selectedParts ?? batchCommand(primary ?? command, selection === "selected" ? result.selectedTests : [])),
    ...extras,
  ] : [];
  return { selection, command: commands.length ? commands.join(" && ") : shard ? undefined : command, commands, reason, outsideSuite, unshardable };
}

/** A test-script phase as a standalone command. `npm test` puts `node_modules/.bin` on PATH; outside
 * it a repository-local runner such as tsx is reached the way selected TypeScript tests are. */
export function phaseCommand(phase: string): string {
  return /^node\s/.test(phase) ? phase : `npx --no-install ${phase}`;
}
