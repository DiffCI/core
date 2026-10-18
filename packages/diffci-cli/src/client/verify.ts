import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { inferFullCommand, inferSelectedCommand } from "./full-command.js";
import { observe } from "./observe.js";
import type { ObservationCommitRange, ObservationReport } from "./report.js";
import { measureCommand, type CommandMeasurement } from "./verify-savings.js";
import { captureWorkingTreeSnapshot, type WorkingTreeSnapshot } from "./working-tree.js";

export const VERIFICATION_SCHEMA = "diffci.verification.v1" as const;

export type VerificationStatus = "passed" | "failed" | "blocked";
export type VerificationScope = "working-tree" | "commit-range";

export interface VerificationReport {
  schema: typeof VERIFICATION_SCHEMA;
  schema_version: "1";
  produced_at: string;
  scope: VerificationScope;
  verification: VerificationStatus;
  safe_to_continue: boolean;
  reason: string;
  changed_files: number;
  tests_available: number;
  tests_selected: number;
  selection: "none" | "selected" | "full";
  command?: string;
  execution?: CommandMeasurement;
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
    unchanged: boolean;
  };
  analysis: {
    status: "not_needed" | ObservationReport["status"];
    stage?: ObservationReport["stage"];
    mode?: ObservationReport["result"] extends infer T ? (T extends { mode: infer M } ? M : never) : never;
    fallback_reasons: string[];
    error?: string;
  };
  required_actions: string[];
}

interface VerifyOptions {
  repoPath: string;
  env: Record<string, string | undefined>;
  version: string;
  engineSha?: string;
  timeoutMs: number;
  tailBytes: number;
  redactPaths?: boolean;
}

export interface VerifyChangedOptions extends VerifyOptions {}

export interface VerifyRangeOptions extends VerifyOptions {
  baseOverride?: string;
  headOverride?: string;
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
  options: VerifyOptions,
  scope: VerificationScope,
  before: WorkingTreeSnapshot,
  observation: ObservationReport,
): Promise<VerificationReport> {
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
  };

  if (observation.status !== "OBSERVED" || !result) {
    return blocked(before, scope, observation.reason ?? "DiffCI analysis did not produce a verification plan", analysis, counts, boundRange);
  }
  if (scope === "commit-range") {
    if (!range) return blocked(before, scope, "DiffCI did not resolve a commit range", analysis, counts);
    if (range.headSha !== before.baseSha) {
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

  const { selection, command, reason } = executableSelection(options.repoPath, result);

  if (!command) {
    const inferred = inferFullCommand(options.repoPath);
    return blocked(before, scope, `no executable verification command is available: ${inferred.reason}`, analysis, counts, boundRange);
  }

  const execution = measureCommand(command, { cwd: options.repoPath, timeoutMs: options.timeoutMs, tailBytes: options.tailBytes });
  let after: WorkingTreeSnapshot;
  try {
    after = captureWorkingTreeSnapshot(options.repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...blocked(before, scope, `could not confirm the post-verification snapshot: ${message}`, analysis, counts, boundRange),
      selection,
      command,
      execution,
    };
  }

  const unchanged = before.baseSha === after.baseSha && before.treeSha === after.treeSha;
  const succeeded = execution.exitCode === 0 && !execution.timedOut;
  const verification: VerificationStatus = !unchanged ? "blocked" : succeeded ? "passed" : "failed";
  const finalReason = !unchanged
    ? "the working tree changed while verification was running; rerun DiffCI for the new snapshot"
    : succeeded
      ? reason
      : execution.timedOut
        ? `verification timed out after ${options.timeoutMs}ms`
        : `verification command failed with exit code ${String(execution.exitCode)}`;

  return {
    ...baseReport(before, scope, boundRange),
    verification,
    safe_to_continue: verification === "passed",
    reason: finalReason,
    changed_files: counts.changedFiles,
    tests_available: counts.testsAvailable,
    tests_selected: selection === "full" ? counts.testsAvailable : counts.testsSelected,
    selection,
    command,
    execution,
    snapshot: {
      ...baseReport(before, scope, boundRange).snapshot,
      after_base_sha: after.baseSha,
      after_tree_sha: after.treeSha,
      unchanged,
    },
    analysis,
    required_actions: verification === "passed" ? [] : [finalReason],
  };
}

/** Verify exactly the staged, unstaged, and non-ignored untracked content currently on disk. */
export async function verifyChanged(options: VerifyChangedOptions): Promise<VerificationReport> {
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
    });
    return await executeObservation({ ...options, repoPath }, "working-tree", before, observation);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Verify a real commit range and bind the receipt to the clean commit that was actually executed. */
export async function verifyRange(options: VerifyRangeOptions): Promise<VerificationReport> {
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
    });
    return await executeObservation({ ...options, repoPath }, "commit-range", before, observation);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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
  if (report.command) lines.push(`  command: ${report.command}`);
  return lines.join("\n");
}



/** Shared executable plan for read-only agent selection and verification. */
export function executableSelection(repoPath: string, result: NonNullable<ObservationReport["result"]>) {
  let selection: "selected" | "full";
  let command: string | undefined;
  let reason: string;
  if (result.mode === "SELECTIVE" && !result.commandRefusalReason && result.proposedCommands.length === 1) {
    const selected = inferSelectedCommand(repoPath, result.proposedCommands[0]!, result.selectedTests);
    if (selected.command) {
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

  return { selection, command, reason };
}
