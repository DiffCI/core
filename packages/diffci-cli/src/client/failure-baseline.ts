import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { measureCommands } from "./command-batches.js";

/**
 * Did this change introduce the failures, or were they already there? (2026-10-21.)
 *
 * WHY. 44 of DentalPresence's 124 verification receipts failed, and about 31 of those were one
 * route-list assertion failing on commit after commit. Each receipt told the agent "verification
 * failed" with nothing to separate a regression it caused from a suite that was already red.
 *
 * WHAT. On request, the failing command is rerun against the base commit, exported with `git archive`
 * into a temporary directory (the repository, its index and its .git are never written), and the
 * failing test names on both sides are compared. The verdict never changes: a red suite stays
 * `failed` and `safe_to_continue` stays false, because required CI fails either way. Only the
 * explanation changes.
 *
 * WHEN IT DECLINES. No identifiable failing test names, a dependency manifest or lockfile that differs
 * between base and head (the base would run against the wrong installed dependencies), no installed
 * node_modules to share, or an export or run that fails to start: the status is `unknown`, with why.
 */
export interface FailureBaseline {
  status: "preexisting" | "introduced" | "mixed" | "unknown";
  base_sha: string;
  reason: string;
  failing_at_head: number;
  failing_at_base?: number;
  /** Failing test names found on both sides, at most 20. */
  preexisting: string[];
  /** Failing test names found only at head, at most 20. */
  introduced: string[];
  base_execution?: { exit_code: number | null; wall_ms: number; timed_out: boolean };
}

const DEPENDENCY_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

/** Test names a runner reported as failing: node:test spec and TAP, Vitest and Jest. */
export function failingTestNames(output: string): string[] {
  const names = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const spec = /^\s*✖\s+(.+?)\s+\(\d+(?:\.\d+)?m?s\)\s*$/.exec(line);
    const tap = /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/.exec(line);
    const vitest = /^\s*(?:FAIL|×)\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/.exec(line);
    const jest = /^\s*●\s+(.+›.+?)\s*$/.exec(line);
    const name = (spec ?? tap ?? vitest ?? jest)?.[1]?.trim();
    if (name && !/^failing tests:?$/i.test(name)) names.add(name);
  }
  return [...names].sort();
}

function declaresDependencies(repoPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some((field) => Object.keys((pkg[field] as object | undefined) ?? {}).length > 0);
  } catch {
    return existsSync(join(repoPath, "package.json"));
  }
}

function git(repoPath: string, args: string[]) {
  return spawnSync("git", args, { cwd: repoPath, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
}

export function compareWithBaseline(input: {
  repoPath: string;
  baseSha: string;
  /** The commit (or snapshot commit) that was verified. */
  headSha: string;
  commands: readonly string[];
  headFailures: readonly string[];
  timeoutMs: number;
}): FailureBaseline {
  const report = (status: FailureBaseline["status"], reason: string, extra: Partial<FailureBaseline> = {}): FailureBaseline => ({
    status, base_sha: input.baseSha, reason, failing_at_head: input.headFailures.length, preexisting: [], introduced: [], ...extra,
  });
  if (input.headFailures.length === 0) return report("unknown", "no failing test names could be identified in the verification output");
  const run = withBaseTree(input, (directory): FailureBaseline => {
    const execution = measureCommands(input.commands, { cwd: directory, timeoutMs: input.timeoutMs, tailBytes: 0 });
    const baseExecution = { exit_code: execution.exitCode, wall_ms: execution.wallMs, timed_out: execution.timedOut };
    if (execution.timedOut) return report("unknown", "the base run timed out", { base_execution: baseExecution });
    const atBase = new Set(execution.failingTests ?? []);
    if (execution.exitCode === 0) {
      return report("introduced", "the same command passes at the base commit", { failing_at_base: 0, introduced: input.headFailures.slice(0, 20), base_execution: baseExecution });
    }
    const preexisting = input.headFailures.filter((name) => atBase.has(name));
    const introduced = input.headFailures.filter((name) => !atBase.has(name));
    const status = introduced.length === 0 ? "preexisting" : preexisting.length === 0 ? "introduced" : "mixed";
    const reason = status === "preexisting"
      ? `all ${preexisting.length} failing test(s) also fail at the base commit`
      : status === "introduced"
        ? `none of the ${introduced.length} failing test(s) fail at the base commit`
        : `${introduced.length} failing test(s) are new; ${preexisting.length} also fail at the base commit`;
    return report(status, reason, { failing_at_base: atBase.size, preexisting: preexisting.slice(0, 20), introduced: introduced.slice(0, 20), base_execution: baseExecution });
  });
  return run.ok ? run.value : report("unknown", run.reason);
}

/**
 * A gate check that failed at head, rerun at the base (2026-10-31). The CI replay found 5 introduced
 * breakages hidden behind a check that was already red at the base (DentalPresence `validate:aws`):
 * verify stopped at that check and never reached the change's own failure. A check is all or nothing,
 * so the comparison is its exit status, not test names.
 */
export interface CheckBaseline {
  status: "preexisting" | "introduced" | "unknown";
  base_sha: string;
  reason: string;
  base_execution?: { exit_code: number | null; wall_ms: number; timed_out: boolean };
}

export function checkAtBaseline(input: { repoPath: string; baseSha: string; headSha: string; command: string; timeoutMs: number }): CheckBaseline {
  const report = (status: CheckBaseline["status"], reason: string, extra: Partial<CheckBaseline> = {}): CheckBaseline => ({ status, base_sha: input.baseSha, reason, ...extra });
  const run = withBaseTree(input, (directory): CheckBaseline => {
    const execution = measureCommands([input.command], { cwd: directory, timeoutMs: input.timeoutMs, tailBytes: 0 });
    const baseExecution = { exit_code: execution.exitCode, wall_ms: execution.wallMs, timed_out: execution.timedOut };
    if (execution.timedOut) return report("unknown", "the base run timed out", { base_execution: baseExecution });
    return execution.exitCode === 0
      ? report("introduced", "the same check passes at the base commit", { base_execution: baseExecution })
      : report("preexisting", "the same check also fails at the base commit", { base_execution: baseExecution });
  });
  return run.ok ? run.value : report("unknown", run.reason);
}

type BaseTree<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Runs `use` in the base commit, exported with `git archive` into a temporary directory with the
 * repository's installed node_modules linked in. The same declines apply to tests and checks: the
 * dependency manifests differ, or nothing is installed. The repository itself is never written.
 */
function withBaseTree<T>(input: { repoPath: string; baseSha: string; headSha: string }, use: (directory: string) => T): BaseTree<T> {
  const changedDependencies = git(input.repoPath, ["diff", "--quiet", input.baseSha, input.headSha, "--", ...DEPENDENCY_FILES]);
  if (changedDependencies.status !== 0) return { ok: false, reason: "dependency manifests or lockfiles differ between base and head" };
  const modules = join(input.repoPath, "node_modules");
  if (declaresDependencies(input.repoPath) && !existsSync(modules)) {
    return { ok: false, reason: "no installed node_modules to run the base commit with" };
  }

  const directory = mkdtempSync(join(tmpdir(), "diffci-baseline-"));
  const link = join(directory, "node_modules");
  try {
    const archive = git(input.repoPath, ["archive", "--format=tar", input.baseSha]);
    if (archive.status !== 0) return { ok: false, reason: "the base commit could not be exported" };
    const extract = spawnSync("tar", ["-x", "-f", "-", "-C", directory], { input: archive.stdout, maxBuffer: 64 * 1024 * 1024 });
    if (extract.status !== 0) return { ok: false, reason: "the base commit could not be extracted" };
    if (existsSync(modules)) symlinkSync(modules, link, process.platform === "win32" ? "junction" : "dir");
    return { ok: true, value: use(directory) };
  } catch (error) {
    return { ok: false, reason: `the base run could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    // Remove the dependency link itself first, so cleanup can never descend into the real node_modules.
    let linked = false;
    try {
      if (lstatSync(link, { throwIfNoEntry: false })) {
        try { unlinkSync(link); } catch { rmdirSync(link); }
      }
    } catch { linked = true; }
    // If the link could not be removed, leave the temporary directory rather than risk the real one.
    if (!linked) rmSync(directory, { recursive: true, force: true });
  }
}
