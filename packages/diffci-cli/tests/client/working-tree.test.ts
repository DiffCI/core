import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { captureWorkingTreeSnapshot } from "../../src/client/working-tree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

describe("working-tree verification snapshots", () => {
  it("captures staged, unstaged, and untracked content without changing the real index", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-worktree-"));
    try {
      git(dir, "init", "--quiet");
      git(dir, "config", "user.email", "test@diffci.local");
      git(dir, "config", "user.name", "Test");
      git(dir, "config", "core.autocrlf", "false");
      write(dir, "tracked.txt", "initial\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "initial");

      write(dir, "tracked.txt", "staged\n");
      git(dir, "add", "tracked.txt");
      write(dir, "tracked.txt", "unstaged after staged\n");
      write(dir, "new.txt", "untracked\n");
      const statusBefore = git(dir, "status", "--porcelain=v1");
      const realIndexBefore = readFileSync(join(dir, ".git", "index"));

      const snapshot = captureWorkingTreeSnapshot(dir);

      assert.equal(snapshot.changed, true);
      assert.match(snapshot.baseSha, /^[a-f0-9]{40}$/);
      assert.match(snapshot.treeSha, /^[a-f0-9]{40}$/);
      assert.match(snapshot.commitSha, /^[a-f0-9]{40}$/);
      assert.equal(git(dir, "status", "--porcelain=v1"), statusBefore);
      assert.deepEqual(readFileSync(join(dir, ".git", "index")), realIndexBefore);
      const names = git(dir, "diff-tree", "--no-commit-id", "--name-only", "-r", snapshot.baseSha, snapshot.commitSha).split(/\r?\n/).sort();
      assert.deepEqual(names, ["new.txt", "tracked.txt"]);

      write(dir, "new.txt", "changed again\n");
      const after = captureWorkingTreeSnapshot(dir);
      assert.notEqual(after.treeSha, snapshot.treeSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


