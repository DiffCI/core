import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface WorkingTreeSnapshot {
  /** The real checked-out commit this snapshot is relative to. */
  baseSha: string;
  /** Git tree identity covering tracked, staged, unstaged, and non-ignored untracked files. */
  treeSha: string;
  /** Unreachable commit used only so the existing commit-range analyzer can inspect the tree. */
  commitSha: string;
  changed: boolean;
  /** Set when every difference from HEAD is a CRLF checkout of an LF-committed file (see lineEndingOnlyChanges). */
  lineEndingOnly?: string[];
}

/**
 * The paths, when every difference between HEAD and the snapshot is only CRLF line endings on files
 * committed with LF; otherwise undefined.
 *
 * WHY (2026-11-06). On DentalPresence the pre-push hook could not verify any push: 268 files had been
 * checked out with CRLF under Git for Windows' system-wide `core.autocrlf=true` before the repository
 * set it to false. `git status` called the checkout clean because its stat cache still matched, while
 * the snapshot re-reads every file and saw 268 changes. Git's own view decides "clean" for the user, so
 * a CRLF-only checkout is verified rather than blocked, and the receipt names the files.
 */
export function lineEndingOnlyChanges(repoPathInput: string, snapshot: WorkingTreeSnapshot): string[] | undefined {
  const repoPath = resolve(repoPathInput);
  const baseTreeSha = requireGit(repoPath, ["rev-parse", "--verify", `${snapshot.baseSha}^{tree}`], "could not resolve the snapshot base tree");
  const changes = snapshotChanges(repoPath, baseTreeSha, snapshot.treeSha);
  if (changes.length === 0 || changes.some((change) => change.status !== "modified")) return undefined;
  for (const change of changes) {
    const committed = spawnSync("git", ["cat-file", "blob", `${baseTreeSha}:${change.path}`], {
      cwd: repoPath,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    if (committed.status !== 0 || committed.stdout.includes(13)) return undefined;
    let checkedOut: Buffer;
    try {
      checkedOut = readFileSync(join(repoPath, change.path));
    } catch {
      return undefined;
    }
    if (!checkedOut.includes(13)) return undefined;
    const normalized = Buffer.from(checkedOut.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    if (!normalized.equals(committed.stdout)) return undefined;
  }
  return changes.map((change) => change.path);
}

/** One path that differs between two snapshots. A rename is a deletion plus an addition. */
export interface SnapshotChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGit(repoPath: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): GitResult {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function requireGit(repoPath: string, args: string[], context: string, env?: NodeJS.ProcessEnv, input?: string): string {
  const result = runGit(repoPath, args, env, input);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited with status ${String(result.status)}`;
    throw new Error(`${context}: ${detail.split("\n")[0]}`);
  }
  return result.stdout.trim();
}

/**
 * Materialize the current worktree as a Git tree without changing the user's index or checkout.
 *
 * A temporary index begins at HEAD and stages the working tree into that isolated index. Git therefore
 * applies the repository's normal ignore rules, executable-bit handling, symlink handling, and clean
 * filters, while the real index and every source file stay untouched. The resulting tree SHA is a
 * content-addressed verification identity. The synthetic commit is intentionally unreachable and is
 * used only by DiffCI's existing commit-to-commit analyzer.
 */
export function captureWorkingTreeSnapshot(repoPathInput: string): WorkingTreeSnapshot {
  const repoPath = resolve(repoPathInput);
  const baseSha = requireGit(repoPath, ["rev-parse", "--verify", "HEAD^{commit}"], "could not resolve repository HEAD");
  const baseTreeSha = requireGit(repoPath, ["rev-parse", "--verify", "HEAD^{tree}"], "could not resolve repository HEAD tree");
  const unmerged = requireGit(repoPath, ["ls-files", "--unmerged"], "could not inspect the repository index");
  if (unmerged !== "") throw new Error("the repository index contains unresolved merge entries");

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "diffci-working-tree-"));
  const temporaryIndex = join(temporaryDirectory, "index");
  const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex };
  try {
    requireGit(repoPath, ["read-tree", baseSha], "could not initialize the verification snapshot", indexEnvironment);
    requireGit(repoPath, ["add", "-A", "--", "."], "could not capture the working tree", indexEnvironment);
    const treeSha = requireGit(repoPath, ["write-tree"], "could not write the verification tree", indexEnvironment);
    const identityEnvironment = {
      GIT_AUTHOR_NAME: "DiffCI",
      GIT_AUTHOR_EMAIL: "snapshot@diffci.local",
      GIT_COMMITTER_NAME: "DiffCI",
      GIT_COMMITTER_EMAIL: "snapshot@diffci.local",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const commitSha = requireGit(
      repoPath,
      ["commit-tree", treeSha, "-p", baseSha],
      "could not create the verification snapshot",
      identityEnvironment,
      "DiffCI working tree snapshot\n",
    );
    return { baseSha, treeSha, commitSha, changed: treeSha !== baseTreeSha };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** The paths that differ between two snapshot trees of the same repository. */
export function snapshotChanges(repoPathInput: string, beforeTreeSha: string, afterTreeSha: string): SnapshotChange[] {
  if (beforeTreeSha === afterTreeSha) return [];
  const fields = requireGit(
    resolve(repoPathInput),
    ["diff-tree", "-r", "--no-renames", "--name-status", "-z", beforeTreeSha, afterTreeSha],
    "could not compare verification snapshots",
  ).split("\0").filter(Boolean);
  const changes: SnapshotChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!;
    changes.push({ path: fields[i + 1]!, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
  }
  return changes;
}


