import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { narrowGateChecks, type ChangedPath } from "@diffci.com/core/planner/check-narrowing";
import { discoverGateChecks, workflowGateScripts, type GateCheckKind } from "@diffci.com/core/planner/pipeline-steps";
import { discoverPythonChecks, narrowPythonChecks, type WorkflowFile } from "@diffci.com/core/planner/python-checks";
import type { CheckBaseline } from "./failure-baseline.js";
import { isPythonSession, readPythonSessionFile, withSessionEnvironment } from "./python-session-files.js";
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
  /** Present when a failed check was rerun at the base commit (`--baseline-on-failure`). */
  baseline?: CheckBaseline;
}

/** The commits a change runs between; without one every check runs as written. */
export interface CheckChange {
  baseSha: string;
  headSha: string;
}

function workflowFiles(repoPath: string): WorkflowFile[] {
  const dir = join(repoPath, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort().flatMap((name) => {
    try { return [{ path: `.github/workflows/${name}`, text: readFileSync(join(dir, name), "utf8") }]; } catch { return []; }
  });
}

function workflowTexts(repoPath: string): string[] {
  return workflowFiles(repoPath).map((file) => file.text);
}

/** True when `command` names a program on PATH (with PATHEXT on Windows). */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (/[\\/]/.test(command)) return false;
  const windows = platform === "win32";
  const extensions = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(windows ? ";" : ":").filter(Boolean)) {
    for (const extension of windows && !/\.\w+$/.test(command) ? ["", ...extensions] : [""]) {
      try { if (statSync(join(dir, command + extension)).isFile()) return true; } catch { /* not here */ }
    }
  }
  return false;
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

function treesHaveNoLinks(repoPath: string, change: CheckChange): boolean {
  // Symlinks can redirect an input and gitlinks hide the submodule's files.
  try {
    return [change.baseSha, change.headSha].every((ref) => !/(?:^|\0)(?:120000|160000) /.test(git(repoPath, ["ls-tree", "-r", "-z", ref])));
  } catch { return false; }
}

/**
 * The checks the repository's gate runs besides its tests (2026-10-29, docs/design/pipeline-impact.md).
 * Agents ran the tests DiffCI selected and then failed `npm run check` after push; these are the rest of
 * the gate. With a change, per-file lint and format checks are narrowed to its files or skipped
 * (check-narrowing.ts); if the change cannot be read, every check runs. No package.json, or one that
 * cannot be read, has no package checks. Python checks that CI workflows run follow them (pythonChecks).
 * `extraRoots` replaces the scripts CI workflows add to the gate, for a caller
 * that knows exactly which scripts its build runs (`diffci gate --script`); it also leaves Python checks out.
 */
export function plannedChecks(repoPath: string, change?: CheckChange, options: { extraRoots?: readonly string[] } = {}): PlannedCheck[] {
  const checks = packageChecks(repoPath, change, options);
  // `extraRoots` names exactly the scripts the caller's build runs; workflow-read Python checks would add others.
  return options.extraRoots ? checks : [...checks, ...pythonChecks(repoPath, change)];
}

function packageChecks(repoPath: string, change: CheckChange | undefined, options: { extraRoots?: readonly string[] }): PlannedCheck[] {
  const path = join(repoPath, "package.json");
  if (!existsSync(path)) return [];
  let pkg: { scripts?: unknown; packageManager?: unknown };
  try { pkg = JSON.parse(readFileSync(path, "utf8")); }
  catch { return []; }
  if (!pkg.scripts || typeof pkg.scripts !== "object") return [];
  const scripts = Object.fromEntries(Object.entries(pkg.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const manager = packageManager(repoPath, pkg.packageManager);
  const lifecycleHooks = manager !== "pnpm";
  const workflowScripts = options.extraRoots ?? workflowGateScripts(workflowTexts(repoPath), scripts);
  let { checks } = discoverGateChecks(scripts, { lifecycleHooks, workflowScripts });
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

/**
 * Python checks CI workflows run (`make type-check-core`, `uv run mypy src`; Core python-checks.ts). With a
 * change, Python-only checks are skipped when no Python file or configuration changed. A check whose
 * program is not installed here is skipped with that reason rather than failed: CI still runs it.
 */
function pythonChecks(repoPath: string, change: CheckChange | undefined): PlannedCheck[] {
  const read = (file: string) => readRepositoryFile(repoPath, file);
  // The package's previous Core pin uses only the Makefile reader and discovers no sessions.
  const discover: (files: WorkflowFile[], readFile: typeof read, readSession: typeof read) => ReturnType<typeof discoverPythonChecks> = discoverPythonChecks;
  let checks = discover(workflowFiles(repoPath), read, (file) => readPythonSessionFile(repoPath, file));
  // GitHub workflows are files in the repository. A link, including a linked
  // parent directory, cannot establish that the workflow declares this session.
  checks = checks.filter((check) => {
    if (!isPythonSession(check.command)) return true;
    try {
      return lstatSync(join(repoPath, ".github")).isDirectory()
        && lstatSync(join(repoPath, ".github/workflows")).isDirectory()
        && lstatSync(join(repoPath, check.script)).isFile();
    } catch { return false; }
  });
  if (checks.length === 0) return [];
  if (change) {
    // Older Core releases accept only the first two arguments and discover no sessions.
    const narrow: (found: typeof checks, changes: ChangedPath[], regular: () => boolean) => typeof checks = narrowPythonChecks;
    let regular: boolean | undefined;
    try { checks = narrow(checks, changedPaths(repoPath, change), () => regular ??= treesHaveNoLinks(repoPath, change)); }
    catch { /* The change could not be read: every check runs as discovered. */ }
  }
  return checks.map((check) => {
    const program = check.command.split(" ")[0]!;
    const missing = check.decision !== "SKIP" && !onPath(program);
    return {
      id: check.id,
      kind: check.kind,
      decision: missing ? "SKIP" : check.decision,
      command: check.command,
      reason: missing ? `${check.reason}; \`${program}\` is not installed here, so CI runs it` : check.reason,
    };
  });
}

/** An earlier gate check, or a different commit in a baseline export, can
 * change what a session name runs. Read its actual workflow and config again. */
export function canRunPythonSession(repoPath: string, command: string): boolean {
  if (!isPythonSession(command)) return true;
  try { return pythonChecks(repoPath, undefined).some((check) => check.command === command && check.decision === "RUN"); }
  catch { return false; }
}

/** Runs checks in order and stops at the first failure, as the gate's `&&` chain would. SKIP checks
 * are recorded as skipped and not run. `baseline` reruns a failed check at the base commit; one that
 * fails there too is recorded in `preexisting` and the run goes on, so a check that was already red
 * cannot hide what the change itself broke. */
export function runChecks(
  checks: readonly PlannedCheck[],
  options: { cwd: string; timeoutMs: number; tailBytes: number; baseline?: (check: PlannedCheck, remainingMs: number) => CheckBaseline },
) {
  const started = Date.now();
  const results: CheckResult[] = [];
  const preexisting: CheckResult[] = [];
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
    if (!canRunPythonSession(options.cwd, check.command)) {
      results.push({ ...check, decision: "SKIP", status: "skipped", reason: "the workflow session could not be confirmed before execution; CI runs it" });
      continue;
    }
    const measurement = withSessionEnvironment(check.command, (env) => measureCommand(check.command, { ...options, env, timeoutMs: remaining }));
    if (!measurement) {
      results.push({ ...check, decision: "SKIP", status: "skipped", reason: "a private Python bytecode cache could not be prepared; CI runs this session" });
      continue;
    }
    const status = measurement.timedOut ? "timed_out" : measurement.exitCode === 0 && measurement.signal === null ? "passed" : "failed";
    const result: CheckResult = { ...check, status, exit_code: measurement.exitCode, wall_ms: measurement.wallMs };
    results.push(result);
    if (status === "passed") continue;
    // Only a check run as written is comparable at the base: a NARROWED one names files the base may not have.
    if (status === "failed" && check.decision === "RUN" && options.baseline) {
      result.baseline = options.baseline(check, options.timeoutMs - (Date.now() - started));
      if (result.baseline.status === "preexisting") {
        preexisting.push(result);
        continue;
      }
    }
    failure = { check: result, measurement };
  }
  const outOfTime = !failure && results.some((result) => result.status === "not_run");
  return { results, failure, preexisting, outOfTime, wallMs: Date.now() - started };
}
