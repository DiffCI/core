import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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


