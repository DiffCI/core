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
  /** Files left out of the snapshot because they differ from HEAD only by a CRLF checkout of LF content (crlfCheckouts). */
  lineEndingOnly?: string[];
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
 * Files staged in the temporary index that differ from the base tree only because the checkout has CRLF
 * where the commit has LF (2026-11-15). On diffci.com, 968 of 1,020 "changed" files were such checkouts
 * next to 52 real changes. The earlier rule (2026-11-06, DentalPresence's pre-push hook) cleared them only
 * when nothing else had changed, so the analysis
 * resolved readers for every one, chose the full suite, and verify took 15 minutes. `git status` calls
 * these files clean, and so does the snapshot now, whatever else changed; the receipt lists them.
 */
function crlfCheckouts(repoPath: string, baseTreeSha: string, indexEnvironment: NodeJS.ProcessEnv): string[] {
  const modified = requireGit(repoPath, ["diff-index", "--cached", "--no-renames", "--diff-filter=M", "--name-only", "-z", baseTreeSha], "could not compare the working tree with HEAD", indexEnvironment)
    .split("\0").filter(Boolean);
  const candidates: Array<{ path: string; normalized: Buffer }> = [];
  for (const path of modified) {
    let checkedOut: Buffer;
    try { checkedOut = readFileSync(join(repoPath, path)); } catch { continue; }
    if (!checkedOut.includes(13)) continue;
    candidates.push({ path, normalized: Buffer.from(checkedOut.toString("latin1").replace(/\r\n/g, "\n"), "latin1") });
  }
  if (candidates.length === 0) return [];
  // One batch read of the committed blobs: `--batch` prints "<sha> blob <size>\n<bytes>\n" per object.
  const batch = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoPath,
    input: candidates.map(({ path }) => `${baseTreeSha}:${path}\n`).join(""),
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (batch.status !== 0) return [];
  const output = batch.stdout;
  const found: string[] = [];
  let offset = 0;
  for (const { path, normalized } of candidates) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) break;
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (header[1] !== "blob") { offset = headerEnd + 1; continue; }
    const size = Number(header[2]);
    const committed = output.subarray(headerEnd + 1, headerEnd + 1 + size);
    offset = headerEnd + 1 + size + 1;
    if (!committed.includes(13) && normalized.equals(committed)) found.push(path);
  }
  return found;
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
    const lineEndingOnly = crlfCheckouts(repoPath, baseTreeSha, indexEnvironment);
    if (lineEndingOnly.length > 0) {
      requireGit(repoPath, ["reset", "-q", baseSha, "--pathspec-from-file=-", "--pathspec-file-nul"], "could not leave line-ending-only files out of the snapshot", indexEnvironment, `${lineEndingOnly.join("\0")}\0`);
    }
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
    return { baseSha, treeSha, commitSha, changed: treeSha !== baseTreeSha, ...(lineEndingOnly.length > 0 ? { lineEndingOnly } : {}) };
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


