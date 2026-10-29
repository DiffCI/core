import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverGateChecks, workflowGateScripts, type GateCheckKind } from "@diffci.com/core/planner/pipeline-steps";
import { measureCommand } from "./verify-savings.js";

/** One leaf of the repository's gate (`npm run check`), as an agent or verify runs it. */
export interface PlannedCheck {
  id: string;
  kind: GateCheckKind;
  command: string;
  reason: string;
}

export interface CheckResult extends PlannedCheck {
  status: "passed" | "failed" | "timed_out" | "not_run";
  exit_code?: number | null;
  wall_ms?: number;
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

/**
 * The checks the repository's gate runs besides its tests (2026-10-29, docs/design/pipeline-impact.md).
 * Agents ran the tests DiffCI selected and then failed `npm run check` after push; these are the rest of
 * the gate. Every check runs: none is narrowed yet. No package.json, or one that cannot be read, has none.
 */
export function plannedChecks(repoPath: string): PlannedCheck[] {
  const path = join(repoPath, "package.json");
  if (!existsSync(path)) return [];
  let pkg: { scripts?: unknown; packageManager?: unknown };
  try { pkg = JSON.parse(readFileSync(path, "utf8")); }
  catch { return []; }
  if (!pkg.scripts || typeof pkg.scripts !== "object") return [];
  const scripts = Object.fromEntries(Object.entries(pkg.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const manager = packageManager(repoPath, pkg.packageManager);
  const { checks } = discoverGateChecks(scripts, { lifecycleHooks: manager !== "pnpm", workflowScripts: workflowGateScripts(workflowTexts(repoPath), scripts) });
  return checks.map((check) => ({
    id: check.id,
    kind: check.kind,
    command: check.runsScript
      ? `${manager} run ${check.script}`
      : /^(?:npm|pnpm|yarn|bun|npx|node)\s/.test(check.command) ? check.command : `npx --no-install ${check.command}`,
    reason: check.reason,
  }));
}

/** Runs checks in order and stops at the first failure, as the gate's `&&` chain would. */
export function runChecks(checks: readonly PlannedCheck[], options: { cwd: string; timeoutMs: number; tailBytes: number }) {
  const started = Date.now();
  const results: CheckResult[] = [];
  let failure: { check: CheckResult; measurement: ReturnType<typeof measureCommand> } | undefined;
  for (const check of checks) {
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
