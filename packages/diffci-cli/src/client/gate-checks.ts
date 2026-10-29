import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { narrowGateChecks, type ChangedPath } from "@diffci.com/core/planner/check-narrowing";
import { discoverGateChecks, workflowGateScripts, type GateCheckKind } from "@diffci.com/core/planner/pipeline-steps";
import { measureCommand } from "./verify-savings.js";

/** One leaf of the repository's gate (`npm run check`), as an agent or verify runs it. */
export interface PlannedCheck {
  id: string;
  kind: GateCheckKind;
  /** RUN as written, NARROWED to the changed files, or SKIP for this change (never run). */
  decision: "RUN" | "NARROWED" | "SKIP";
  command: string;
  reason: string;
}

export interface CheckResult extends PlannedCheck {
  status: "passed" | "failed" | "timed_out" | "not_run" | "skipped";
  exit_code?: number | null;
  wall_ms?: number;
}

/** The commits a change runs between; without one every check runs as written. */
export interface CheckChange {
  baseSha: string;
  headSha: string;
}

function workflowTexts(repoPath: string): string[] {
  const dir = join(repoPath, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort().flatMap((name) => {
    try { return [readFileSync(join(dir, name), "utf8")]; } catch { return []; }
  });
}

function packageManager(repoPath: string, declared: unknown): string {
  const name = typeof declared === "string" ? declared.split("@")[0] : undefined;
  if (name === "pnpm" || name === "yarn" || name === "bun") return name;
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  return "npm";
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** Renames count as a deletion plus an addition: a deleted path can break an import elsewhere. */
function changedPaths(repoPath: string, change: CheckChange): ChangedPath[] {
  const fields = git(repoPath, ["diff", "--name-status", "--no-renames", "-z", change.baseSha, change.headSha]).split("\0").filter(Boolean);
  const changes: ChangedPath[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!;
    changes.push({ path: fields[i + 1]!, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
  }
  return changes;
}

function readRepositoryFile(repoPath: string, path: string): string | undefined {
  try { return readFileSync(join(repoPath, path), "utf8"); } catch { return undefined; }
}

/**
 * The checks the repository's gate runs besides its tests (2026-10-29, docs/design/pipeline-impact.md).
 * Agents ran the tests DiffCI selected and then failed `npm run check` after push; these are the rest of
 * the gate. With a change, per-file lint and format checks are narrowed to its files or skipped
 * (check-narrowing.ts); if the change cannot be read, every check runs. No package.json, or one that
 * cannot be read, has none.
 */
export function plannedChecks(repoPath: string, change?: CheckChange): PlannedCheck[] {
  const path = join(repoPath, "package.json");
  if (!existsSync(path)) return [];
  let pkg: { scripts?: unknown; packageManager?: unknown };
  try { pkg = JSON.parse(readFileSync(path, "utf8")); }
  catch { return []; }
  if (!pkg.scripts || typeof pkg.scripts !== "object") return [];
  const scripts = Object.fromEntries(Object.entries(pkg.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const manager = packageManager(repoPath, pkg.packageManager);
  const lifecycleHooks = manager !== "pnpm";
  let { checks } = discoverGateChecks(scripts, { lifecycleHooks, workflowScripts: workflowGateScripts(workflowTexts(repoPath), scripts) });
  if (change) {
    try {
      const changes = changedPaths(repoPath, change);
      const files = git(repoPath, ["ls-files", "-z"]).split("\0").filter(Boolean);
      checks = narrowGateChecks(checks, { scripts, changes, files, lifecycleHooks, read: (file) => readRepositoryFile(repoPath, file) });
    } catch { /* The change could not be read: every check runs as discovered. */ }
  }
  return checks.map((check) => ({
    id: check.id,
    kind: check.kind,
    decision: check.decision,
    command: check.runsScript
      ? `${manager} run ${check.script}`
      : /^(?:npm|pnpm|yarn|bun|npx|node)\s/.test(check.command) ? check.command : `npx --no-install ${check.command}`,
    reason: check.reason,
  }));
}

/** Runs checks in order and stops at the first failure, as the gate's `&&` chain would. SKIP checks
 * are recorded as skipped and not run. */
export function runChecks(checks: readonly PlannedCheck[], options: { cwd: string; timeoutMs: number; tailBytes: number }) {
  const started = Date.now();
  const results: CheckResult[] = [];
  let failure: { check: CheckResult; measurement: ReturnType<typeof measureCommand> } | undefined;
  for (const check of checks) {
    if (check.decision === "SKIP") {
      results.push({ ...check, status: "skipped" });
      continue;
    }
    const remaining = options.timeoutMs - (Date.now() - started);
    if (failure || remaining <= 0) {
      results.push({ ...check, status: "not_run" });
      continue;
    }
    const measurement = measureCommand(check.command, { ...options, timeoutMs: remaining });
    const status = measurement.timedOut ? "timed_out" : measurement.exitCode === 0 && measurement.signal === null ? "passed" : "failed";
    const result: CheckResult = { ...check, status, exit_code: measurement.exitCode, wall_ms: measurement.wallMs };
    results.push(result);
    if (status !== "passed") failure = { check: result, measurement };
  }
  const outOfTime = !failure && results.some((result) => result.status === "not_run");
  return { results, failure, outOfTime, wallMs: Date.now() - started };
}
