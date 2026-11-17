import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { observe } from "./observe.js";
import { plannedChecks } from "./gate-checks.js";
import { hookCommand } from "./hook.js";
import { detectPackageManager } from "./install.js";
import { createIsolatedWorktree } from "./isolated-worktree.js";
import { requireDiffciPackageIdentity } from "./package-identity.js";
import { executableSelection, scopedChanges } from "./verify.js";
import { captureScopedTree, captureWorkingTreeSnapshot, type VerificationTreeScope, type WorkingTreeSnapshot } from "./working-tree.js";

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

export type AgentSelectionPlan = Awaited<ReturnType<typeof agentSelection>>;

/** Analyze the live snapshot using the same engine as verification. Never executes tests. */
export async function agentSelection(repoInput: string) {
  const repoPath = resolve(repoInput);
  const before = captureWorkingTreeSnapshot(repoPath);
  const changedFiles = changedPaths(repoPath, before);
  const observation = before.changed ? await observe({
    repoPath, env: process.env, version: "agent-selection-v1",
    baseOverride: before.baseSha, headOverride: before.commitSha,
    // The returned commands include any test-script phases (executableSelection).
    selectTestPhases: true,
  }) : undefined;
  const result = observation?.result;
  const after = captureWorkingTreeSnapshot(repoPath);
  const unchanged = before.baseSha === after.baseSha && before.treeSha === after.treeSha;
  let command: string | undefined;
  let commands: string[] = [];
  let selection: "none" | "selected" | "full" = "none";
  let reason = "no uncommitted changes; use diffci_verify for a committed range";
  if (before.changed) {
    reason = observation?.reason ?? "analysis did not produce a runnable plan";
    if (observation?.status === "OBSERVED" && result) {
      ({ command, commands, selection, reason } = executableSelection(repoPath, result));
      if (!command) reason = `no executable verification command is available: ${reason}`;
    }
  }
  const ready = unchanged && (!before.changed || Boolean(command));
  const planned = ready && before.changed ? plannedChecks(repoPath, { baseSha: before.baseSha, headSha: before.commitSha }) : [];
  const checks = planned.filter((check) => check.decision !== "SKIP");
  return {
    schema: "diffci.agent-selection.v1", scope: "working-tree",
    status: ready ? "planned" : "blocked", tests_executed: false,
    snapshot: { base_sha: before.baseSha, tree_sha: before.treeSha, unchanged },
    changed_files: changedFiles, selection,
    selected_tests: selection === "selected" ? result?.selectedTests ?? [] : [],
    tests_available: result?.totalTestCount ?? 0,
    tests_selected: selection === "full" ? result?.totalTestCount ?? 0 : selection === "selected" ? result?.selectedTests.length ?? 0 : 0,
    command: ready ? command : undefined,
    // Run these one after another when present: the joined command exceeds the shell's limit.
    ...(ready && commands.length > 1 ? { commands } : {}),
    // The rest of the repository's gate (lint, typecheck, check scripts), to run before the tests.
    checks,
    skipped_checks: planned.filter((check) => check.decision === "SKIP").map(({ id, reason }) => ({ id, reason })),
    reason: unchanged ? reason : "working tree changed during analysis; reanalyze",
    fallback_reasons: result?.fallbackReasons ?? [],
    analysis_status: observation?.status ?? "not_needed",
    analysis_mode: result?.mode,
    graph_confidence: result?.graph.effectiveConfidence ?? result?.graph.confidence,
    risk_signals: result?.riskSignals ?? [],
    required_ci_authoritative: true,
  };
}

/** How this repository runs DiffCI from a shell: its installed binary, or a pinned npx package. */
function diffciInvocation(repoPath: string, version: string): string {
  let declared = false;
  try {
    const manifest = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    declared = ["dependencies", "devDependencies", "optionalDependencies"].some((field) => Boolean(manifest[field]?.["@diffci.com/diffci"]));
  } catch { /* no package.json: the pinned package below */ }
  if (!declared) return hookCommand(undefined, version);
  try { return hookCommand(detectPackageManager(repoPath), version); }
  catch { return hookCommand("npm", version); }
}

/** A path as one shell word in POSIX shells, cmd.exe and PowerShell. */
function shellPath(path: string): string {
  return /^[A-Za-z0-9_./@+-]+$/.test(path) ? path : `"${path.replace(/"/g, '\\"')}"`;
}

/** The one command that verifies `scope` in isolation, as `diffci_select_tests` returns it. */
export function scopedVerifyCommand(repoPath: string, scope: VerificationTreeScope, version = requireDiffciPackageIdentity().version): string {
  const run = diffciInvocation(repoPath, version);
  return scope.kind === "staged"
    ? `${run} verify --staged --json`
    : `${run} verify --json --paths ${scope.paths.map(shellPath).join(" ")}`;
}

/**
 * The plan for HEAD plus only the staged files, or only the named files (2026-11-17), made in the same
 * temporary worktree `verify --staged` / `--paths` verifies in. Its `command` is that one verify
 * command, which runs the gate checks and the selected tests in isolation: the selected test command
 * itself would run in the shared checkout, where other sessions' files could change its result.
 */
export async function agentScopedSelection(repoInput: string, scope: VerificationTreeScope) {
  const repoPath = resolve(repoInput);
  const { scoped, verified, excluded } = scopedChanges(repoPath, scope);
  const scopeFields = {
    scope: scope.kind,
    isolation: "temporary-worktree" as const,
    excluded_dirty_files: excluded.length,
    excluded_dirty_paths: excluded.slice(0, 50).map((change) => change.path),
  };
  const command = scopedVerifyCommand(repoPath, scope);
  const unplanned = (status: "planned" | "blocked", reason: string) => ({
    schema: "diffci.agent-selection.v1", ...scopeFields, status, tests_executed: false,
    snapshot: { base_sha: scoped.baseSha, tree_sha: scoped.treeSha, unchanged: true },
    changed_files: verified.map((change) => change.path), selection: "none" as const, selected_tests: [] as string[],
    tests_available: 0, tests_selected: 0, command: undefined, checks: [], skipped_checks: [], reason,
    fallback_reasons: [], analysis_status: "not_needed", risk_signals: [], required_ci_authoritative: true,
  });
  if (!scoped.changed) return unplanned("planned", scope.kind === "staged" ? "nothing is staged: the index matches HEAD" : "the given paths do not differ from HEAD");
  const worktree = createIsolatedWorktree(repoPath, scoped.baseSha, scoped.treeSha);
  if ("error" in worktree) return unplanned("blocked", worktree.error);
  let plan: AgentSelectionPlan;
  try { plan = await agentSelection(worktree.path); }
  finally { worktree.dispose(); }
  const after = captureScopedTree(repoPath, scope);
  const unchanged = plan.snapshot.unchanged && after.baseSha === scoped.baseSha && after.treeSha === scoped.treeSha;
  const ready = unchanged && plan.status === "planned";
  return {
    ...plan,
    ...scopeFields,
    status: ready ? "planned" : "blocked",
    snapshot: { base_sha: scoped.baseSha, tree_sha: scoped.treeSha, unchanged },
    changed_files: verified.map((change) => change.path),
    // What the verify command runs inside the temporary worktree, for reading, not for running here.
    ...(plan.command ? { worktree_command: plan.command } : {}),
    command: ready ? command : undefined,
    commands: undefined,
    reason: unchanged ? plan.reason : `the ${scope.kind === "staged" ? "index" : "given files"} or HEAD changed during analysis; reanalyze`,
  };
}

export type AgentScopedSelectionPlan = Awaited<ReturnType<typeof agentScopedSelection>>;

/**
 * One plain sentence ahead of the JSON, naming the exact command to run (2026-10-28). Agents given only
 * the JSON plan mostly went on to pick their own test files or run the whole suite; the first line is
 * what they act on, so it says what to run and nothing else.
 */
export function selectionInstruction(plan: AgentSelectionPlan | AgentScopedSelectionPlan): string {
  if (plan.status === "blocked") return `DiffCI could not plan this change: ${plan.reason}. Run the repository's normal verification and report this.`;
  if (plan.selection === "none") return `Nothing to verify: ${plan.reason}.`;
  const scope = plan.selection === "selected"
    ? `DiffCI selected ${plan.tests_selected} of ${plan.tests_available} test files`
    : `DiffCI requires the full suite (${plan.reason})`;
  if ("isolation" in plan) {
    // One command: it runs the gate checks and the tests in the temporary worktree, where only the
    // scoped files differ from HEAD.
    const what = plan.scope === "staged" ? "HEAD plus your staged files" : "HEAD plus the given files";
    const excluded = plan.excluded_dirty_files ? ` ${plan.excluded_dirty_files} other changed file(s) in this checkout are excluded and stay at their HEAD version.` : "";
    return `${scope} for ${what}.${excluded} Run exactly:\n${plan.command}\nIt runs the gate checks and those tests in a temporary worktree. Do not run the selected tests in this checkout, substitute your own test files, or run the full suite.`;
  }
  const testCommands = plan.commands && plan.commands.length > 1 ? plan.commands : [plan.command];
  const all = [...plan.checks.map((check) => check.command), ...testCommands];
  const skipped = plan.skipped_checks?.length ? ` ${plan.skipped_checks.length} other gate check(s) are not affected by this change.` : "";
  const gate = plan.checks.length ? ` The repository's gate also runs ${plan.checks.length} check(s) (${plan.checks.map((check) => check.id).join(", ")}); run them first.${skipped}` : skipped;
  const run = all.length > 1
    ? `Run these commands in order, exactly as given:\n${all.join("\n")}`
    : `Run exactly:\n${all[0]}`;
  return `${scope}.${gate} ${run}\nDo not substitute your own test files, checks or the full suite.`;
}
