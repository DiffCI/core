import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

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

/**
 * A base run that a signal ended (SIGKILL from the out-of-memory killer, exit 137 through a shell) says
 * nothing about the base commit (2026-11-04, LobeHub: `type-check` was killed at the base while verify
 * still held its heap, and the type error the change introduced read as already broken).
 */
function killedReason(execution: { exitCode: number | null; signal?: string | null }): string | undefined {
  if (execution.signal) return `the base run was killed by ${execution.signal}`;
  if (execution.exitCode !== null && execution.exitCode > 128) return `the base run was killed (exit code ${execution.exitCode}, signal ${execution.exitCode - 128}); out of memory is the usual cause`;
  return undefined;
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
    const killed = killedReason(execution);
    if (killed) return report("unknown", killed, { base_execution: baseExecution });
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
    const killed = killedReason(execution);
    if (killed) return report("unknown", killed, { base_execution: baseExecution });
    return execution.exitCode === 0
      ? report("introduced", "the same check passes at the base commit", { base_execution: baseExecution })
      : report("preexisting", "the same check also fails at the base commit", { base_execution: baseExecution });
  });
  return run.ok ? run.value : report("unknown", run.reason);
}

type BaseTree<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Directories holding a tracked package.json and an installed node_modules: the root, then every
 * workspace package. pnpm and Yarn workspaces install each package's own dependencies there, so a base
 * tree with only the root's linked cannot resolve them, and a type check fails at the base for that
 * alone (2026-11-03, LobeHub replay: a type error the change introduced read as already broken). */
function installedModuleDirs(repoPath: string): string[] {
  const listed = git(repoPath, ["ls-files", "-z", "--", "package.json", "*/package.json"]);
  const dirs = listed.status === 0 ? listed.stdout.toString("utf8").split(" ").filter(Boolean).map((file) => posix.dirname(file)) : ["."];
  return [...new Set(dirs)].filter((dir) => !dir.split("/").includes("node_modules") && existsSync(join(repoPath, dir, "node_modules"))).sort();
}

/**
 * Fills `target` with links to the entries of an installed `source` node_modules (2026-11-05). Linking
 * the whole directory kept the links package managers make to the workspace's own packages
 * (`node_modules/w -> packages/w`) pointing at head, so the base run loaded head's version of every
 * workspace package: an error the change introduced in one also failed at the base and read as already
 * broken. Such an entry now links to the same package in the base tree; every other entry, scoped
 * packages included, links to the installed one. Plain files (`.modules.yaml`) are copied.
 */
function linkModules(source: string, target: string, tree: { repoReal: string; baseTree: string }, links: string[]): void {
  mkdirSync(target);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      linkModules(from, to, tree, links);
      continue;
    }
    if (entry.isFile() || (entry.isSymbolicLink() && statSync(from, { throwIfNoEntry: false })?.isFile())) {
      copyFileSync(from, to);
      continue;
    }
    let linkTo = from;
    if (entry.isSymbolicLink()) {
      let real: string | undefined;
      try { real = realpathSync(from); } catch { real = undefined; }
      const inside = real === undefined ? undefined : relative(tree.repoReal, real);
      if (inside !== undefined && inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) && !inside.split(sep).includes("node_modules")) {
        const atBase = join(tree.baseTree, inside);
        // A workspace package the base does not have: the manifests would differ, so this is rare;
        // without it the base resolves nothing there rather than resolving head.
        if (!existsSync(atBase)) continue;
        linkTo = atBase;
      }
    }
    symlinkSync(linkTo, to, process.platform === "win32" ? "junction" : "dir");
    links.push(to);
  }
}

/**
 * Runs `use` in the base commit, exported with `git archive` into a temporary directory with the
 * repository's installed node_modules linked in, the root's and each workspace package's that the base
 * also has. The same declines apply to tests and checks: the dependency manifests differ, or nothing is
 * installed. The working tree is never written.
 *
 * Memory (2026-11-05, LobeHub replay: a base `type-check` was killed with exit 137 and an introduced type
 * error read as unknown). The archive used to be read into this process, up to 1 GB, and stayed alive
 * while the base command ran; it now goes through a file that is deleted before anything runs. The tree
 * goes under `<git common dir>/diffci/`, beside the outcome log, rather than a temporary directory that a
 * container may keep in memory.
 */
/** `<git common dir>/diffci`, created if needed, or the system temporary directory when that fails. */
function baselineRoot(repoPath: string): string {
  const common = git(repoPath, ["rev-parse", "--git-common-dir"]);
  if (common.status !== 0) return tmpdir();
  const root = join(resolve(repoPath, common.stdout.toString("utf8").trim()), "diffci");
  try { mkdirSync(root, { recursive: true }); return root; } catch { return tmpdir(); }
}

function withBaseTree<T>(input: { repoPath: string; baseSha: string; headSha: string }, use: (directory: string) => T): BaseTree<T> {
  const changedDependencies = git(input.repoPath, ["diff", "--quiet", input.baseSha, input.headSha, "--", ...DEPENDENCY_FILES, ...DEPENDENCY_FILES.map((file) => `*/${file}`)]);
  if (changedDependencies.status !== 0) return { ok: false, reason: "dependency manifests or lockfiles differ between base and head" };
  const modules = join(input.repoPath, "node_modules");
  if (declaresDependencies(input.repoPath) && !existsSync(modules)) {
    return { ok: false, reason: "no installed node_modules to run the base commit with" };
  }

  const directory = mkdtempSync(join(baselineRoot(input.repoPath), "diffci-baseline-"));
  const links: string[] = [];
  try {
    const tarball = `${directory}.tar`;
    const archive = git(input.repoPath, ["archive", "--format=tar", `--output=${tarball}`, input.baseSha]);
    if (archive.status !== 0) { rmSync(tarball, { force: true }); return { ok: false, reason: "the base commit could not be exported" }; }
    // By a relative name: GNU tar reads `C:\...` as a remote host.
    const extract = spawnSync("tar", ["-x", "-f", basename(tarball), "-C", directory], { cwd: dirname(tarball), maxBuffer: 64 * 1024 * 1024 });
    rmSync(tarball, { force: true });
    if (extract.status !== 0) return { ok: false, reason: "the base commit could not be extracted" };
    for (const dir of installedModuleDirs(input.repoPath)) {
      const target = join(directory, dir, "node_modules");
      if (!existsSync(join(directory, dir)) || lstatSync(target, { throwIfNoEntry: false })) continue;
      linkModules(join(input.repoPath, dir, "node_modules"), target, { repoReal: realpathSync(input.repoPath), baseTree: directory }, links);
    }
    return { ok: true, value: use(directory) };
  } catch (error) {
    return { ok: false, reason: `the base run could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    // Remove the dependency links themselves first, so cleanup can never descend into a real node_modules.
    let linked = false;
    for (const link of links) {
      try {
        if (lstatSync(link, { throwIfNoEntry: false })) {
          try { unlinkSync(link); } catch { rmdirSync(link); }
        }
      } catch { linked = true; }
    }
    // If a link could not be removed, leave the temporary directory rather than risk the real one.
    if (!linked) rmSync(directory, { recursive: true, force: true });
  }
}
