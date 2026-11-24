import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * A temporary detached worktree holding exactly one tree (2026-11-17), for `verify --staged` and
 * `verify --paths`: the same isolation the pre-push hook uses (hook.ts, verify_in_worktree), in TypeScript.
 *
 * The worktree's HEAD is the checkout's HEAD and its files are the scoped tree, so the existing
 * working-tree verification runs there unchanged: excluded dirty files in the shared checkout exist only
 * at their HEAD version and can neither break nor rescue the result, at analysis time or at runtime.
 *
 * Dependencies. Each `node_modules` directory of the checkout (four levels deep, as the hook looks) is
 * linked in: a junction on Windows, which needs no privilege, and a symlink elsewhere. Only when every
 * root lockfile in the scoped tree matches the checkout's, by blob id; otherwise the installed
 * dependencies are not the ones the tree asks for, and DiffCI says it cannot verify.
 *
 * Cleanup. `dispose` removes the links first, so removing the worktree can never reach through a link
 * into the real dependencies, then the worktree and its registration. It runs on success, failure and
 * timeout (the caller's `finally`), and on SIGINT, SIGTERM and SIGHUP.
 */
export interface IsolatedWorktree {
  path: string;
  /** Checkout-relative `node_modules` directories linked into the worktree. */
  linked: string[];
  /** Removes links, the worktree and its registration. False when something could not be removed. */
  dispose(): boolean;
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

function git(cwd: string, args: string[], input?: string) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/** Root lockfiles whose content in `treeSha` differs from the checkout's file on disk. */
export function lockfileMismatches(repoPath: string, treeSha: string): string[] {
  const mismatched: string[] = [];
  for (const lock of LOCKFILES) {
    const onDisk = existsSync(join(repoPath, lock)) ? git(repoPath, ["hash-object", "--", lock]).stdout : "";
    const inTree = git(repoPath, ["rev-parse", "-q", "--verify", `${treeSha}:${lock}`]).stdout;
    // Blob ids, not bytes: Git applies the same line-ending normalization on both sides.
    if ((onDisk || inTree) && onDisk !== inTree) mismatched.push(lock);
  }
  return mismatched;
}

/** Checkout-relative `node_modules` directories, at most four levels deep, never inside one another. */
export function dependencyDirectories(repoPath: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    let entries;
    try { entries = readdirSync(join(repoPath, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === "node_modules") { found.push(child); continue; }
      if (depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk("", 1);
  return found.sort();
}

/**
 * TypeScript incremental build information (`*.tsbuildinfo`) under `root`, at most four levels deep, outside
 * node_modules (2026-11-24).
 *
 * WHY. These files are gitignored, so a fresh temporary worktree had none and every `--staged` or `--paths`
 * run type-checked from scratch: DentalPresence's typecheck took a median of 60-90 s there against 25-29 s in
 * the checkout (60 of 142 runs). The checkout's own copy does not help (measured: 57 s and slower against
 * 52-54 s cold), because a worktree reaches node_modules through a link that TypeScript resolves to another
 * path, so every dependency looks changed. A previous temporary worktree's copy does: 22 s against 54 s cold.
 * So each worktree saves its build info to a cache in the git directory when it is disposed, and the next
 * one starts from it. TypeScript records each file's content hash and re-checks any file that differs, so a
 * cached copy only saves work; it can never make a changed file look checked.
 */
export function buildInfoFiles(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    let entries;
    try { entries = readdirSync(join(root, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) found.push(child);
      else if (entry.isDirectory() && depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk("", 1);
  return found.sort();
}

/** Where temporary worktrees keep their build information: inside the git directory, shared by every worktree. */
export function buildInfoCache(repoPath: string): string | undefined {
  const common = git(repoPath, ["rev-parse", "--git-common-dir"]);
  return common.ok && common.stdout ? join(resolve(repoPath, common.stdout), "diffci", "tsbuildinfo") : undefined;
}

/** Copies each build information file from one tree to the other, through a temporary file and a rename. */
function copyBuildInfo(from: string, to: string, onlyIntoExistingDirectories: boolean): void {
  for (const relative of buildInfoFiles(from)) {
    const target = join(to, relative);
    try {
      if (onlyIntoExistingDirectories) { if (!existsSync(dirname(target)) || existsSync(target)) continue; }
      else mkdirSync(dirname(target), { recursive: true });
      const partial = `${target}.diffci-${process.pid}`;
      copyFileSync(join(from, relative), partial);
      renameSync(partial, target);
    } catch { /* without it, the type check only runs from scratch */ }
  }
}

function removeLink(path: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    // A junction is a symbolic link to Node; unlink removes the link, never the target's contents.
    unlinkSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function createIsolatedWorktree(repoPathInput: string, baseSha: string, treeSha: string): IsolatedWorktree | { error: string } {
  const repoPath = resolve(repoPathInput);
  const mismatched = lockfileMismatches(repoPath, treeSha);
  if (mismatched.length) {
    return { error: `${mismatched.join(", ")} in the verified files differs from this checkout's, so its installed dependencies do not match; install dependencies for it, or include the lockfile change the installed dependencies were made from` };
  }
  // The long form of the path: an 8.3 temporary directory (C:\Users\ABCDEF~1) would not match the
  // repository root Git reports inside the worktree.
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "diffci-scoped-")));
  const path = join(temporary, "tree");
  const added = git(repoPath, ["worktree", "add", "--quiet", "--detach", "--no-checkout", path, baseSha]);
  if (!added.ok) {
    rmSync(temporary, { recursive: true, force: true });
    return { error: `could not create a temporary worktree: ${added.stderr.split("\n")[0] ?? "git worktree add failed"}` };
  }

  const linked: string[] = [];
  const cache = buildInfoCache(repoPath);
  let disposed = false;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals) => {
    dispose();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onExit = () => { dispose(); };
  function dispose(): boolean {
    if (disposed) return true;
    disposed = true;
    for (const signal of signals) process.removeListener(signal, onSignal);
    process.removeListener("exit", onExit);
    // The next temporary worktree starts its type check from this one's (buildInfoFiles).
    if (cache) copyBuildInfo(path, cache, false);
    // Links first: removing the worktree must never reach through a link into the checkout.
    const unlinked = linked.every((relative) => removeLink(join(path, relative)));
    let removed = git(repoPath, ["worktree", "remove", "--force", path]).ok;
    if (!removed && unlinked) {
      try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); removed = !existsSync(path); } catch { removed = false; }
    }
    git(repoPath, ["worktree", "prune"]);
    if (removed) {
      try { rmSync(temporary, { recursive: true, force: true }); } catch { /* an empty directory left in the temp folder is harmless */ }
    }
    return removed && unlinked;
  }
  for (const signal of signals) process.once(signal, onSignal);
  process.once("exit", onExit);

  const checkout = git(path, ["read-tree", "--reset", "-u", treeSha]);
  if (!checkout.ok) {
    dispose();
    return { error: `could not check out the verified files in the temporary worktree: ${checkout.stderr.split("\n")[0] ?? "git read-tree failed"}` };
  }
  for (const relative of dependencyDirectories(repoPath)) {
    const target = join(path, relative);
    if (!existsSync(dirname(target)) || existsSync(target)) continue;
    try {
      symlinkSync(join(repoPath, relative), target, "junction");
      linked.push(relative);
    } catch { /* a missing dependency link shows up as a failing or unrunnable test, never as a pass */ }
  }
  // Copied, not linked: this worktree's type check rewrites them, and dispose saves them back.
  if (cache) copyBuildInfo(cache, path, true);
  return { path, linked, dispose };
}
