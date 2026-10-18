import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { observe } from "./observe.js";
import { executableSelection } from "./verify.js";
import { captureWorkingTreeSnapshot, type WorkingTreeSnapshot } from "./working-tree.js";

function changedPaths(repoPath: string, snapshot: WorkingTreeSnapshot): string[] {
  return execFileSync("git", ["diff", "--name-only", "-z", snapshot.baseSha, snapshot.commitSha], {
    cwd: repoPath, encoding: "utf8", windowsHide: true,
  }).split("\0").filter(Boolean);
}

/** Cheap change discovery, without building the dependency graph. */
export function agentChangedFiles(repoInput: string) {
  const repoPath = resolve(repoInput);
  const before = captureWorkingTreeSnapshot(repoPath);
  const changedFiles = changedPaths(repoPath, before);
  const after = captureWorkingTreeSnapshot(repoPath);
  const unchanged = before.baseSha === after.baseSha && before.treeSha === after.treeSha;
  return {
    schema: "diffci.agent-changes.v1", scope: "working-tree",
    status: unchanged ? "observed" : "blocked", tests_executed: false,
    snapshot: { base_sha: before.baseSha, tree_sha: before.treeSha, unchanged },
    changed_files: changedFiles,
    reason: unchanged ? "current changes relative to HEAD" : "working tree changed during discovery; retry",
  };
}

/** Analyze the live snapshot using the same engine as verification. Never executes tests. */
export async function agentSelection(repoInput: string) {
  const repoPath = resolve(repoInput);
  const before = captureWorkingTreeSnapshot(repoPath);
  const changedFiles = changedPaths(repoPath, before);
  const observation = before.changed ? await observe({
    repoPath, env: process.env, version: "agent-selection-v1",
    baseOverride: before.baseSha, headOverride: before.commitSha,
  }) : undefined;
  const result = observation?.result;
  const after = captureWorkingTreeSnapshot(repoPath);
  const unchanged = before.baseSha === after.baseSha && before.treeSha === after.treeSha;
  let command: string | undefined;
  let selection: "none" | "selected" | "full" = "none";
  let reason = "no uncommitted changes; use diffci_verify for a committed range";
  if (before.changed) {
    reason = observation?.reason ?? "analysis did not produce a runnable plan";
    if (observation?.status === "OBSERVED" && result) {
      ({ command, selection, reason } = executableSelection(repoPath, result));
      if (!command) reason = `no executable verification command is available: ${reason}`;
    }
  }
  const ready = unchanged && (!before.changed || Boolean(command));
  return {
    schema: "diffci.agent-selection.v1", scope: "working-tree",
    status: ready ? "planned" : "blocked", tests_executed: false,
    snapshot: { base_sha: before.baseSha, tree_sha: before.treeSha, unchanged },
    changed_files: changedFiles, selection,
    selected_tests: selection === "selected" ? result?.selectedTests ?? [] : [],
    tests_available: result?.totalTestCount ?? 0,
    tests_selected: selection === "full" ? result?.totalTestCount ?? 0 : selection === "selected" ? result?.selectedTests.length ?? 0 : 0,
    command: ready ? command : undefined,
    reason: unchanged ? reason : "working tree changed during analysis; reanalyze",
    fallback_reasons: result?.fallbackReasons ?? [],
    analysis_status: observation?.status ?? "not_needed",
    analysis_mode: result?.mode,
    graph_confidence: result?.graph.effectiveConfidence ?? result?.graph.confidence,
    risk_signals: result?.riskSignals ?? [],
    required_ci_authoritative: true,
  };
}
