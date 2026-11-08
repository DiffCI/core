import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { installPrePushHook } from "../../src/client/hook.js";

/**
 * Drives the real pre-push hook through `git push` to a bare remote. A stub stands in for `diffci`, so
 * the test checks the hook's own mechanics: where verification runs, what it sees, and what cleanup
 * leaves behind (2026-11-08: a stray untracked file made every DentalPresence push unverifiable).
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "diffci-hook-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", remote);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "test");
  git(work, "config", "core.autocrlf", "false");
  writeFileSync(join(work, ".gitignore"), "node_modules\n");
  writeFileSync(join(work, "package-lock.json"), "{}\n");
  writeFileSync(join(work, "a.txt"), "1\n");
  mkdirSync(join(work, "node_modules", "marker"), { recursive: true });
  writeFileSync(join(work, "node_modules", "marker", "KEEP"), "keep\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");

  const log = join(root, "stub.log").replace(/\\/g, "/");
  const stub = join(root, "stub.sh").replace(/\\/g, "/");
  writeFileSync(stub, [
    "#!/bin/sh",
    `{ echo "cwd=$(pwd)"; if [ -f node_modules/marker/KEEP ]; then echo deps=linked; else echo deps=missing; fi; echo "dirty=$(git status --porcelain | wc -l | tr -d ' ')"; echo "args=$*"; } >> "${log}"`,
    'exit "$STUB_EXIT"',
    "",
  ].join("\n"));
  installPrePushHook(work, `sh "${stub}"`, true);
  return { root, work, log };
}

function commitAndPush(work: string, exit: number) {
  writeFileSync(join(work, "a.txt"), `${Date.now()}\n`);
  git(work, "commit", "-q", "-am", "change");
  return spawnSync("git", ["push", "origin", "main"], {
    cwd: work, encoding: "utf8", windowsHide: true, env: { ...process.env, STUB_EXIT: String(exit) },
  });
}

describe("pre-push hook", () => {
  it("verifies in a clean temporary worktree when the checkout has untracked files, and cleans up", () => {
    const { root, work, log } = setup();
    try {
      writeFileSync(join(work, "True"), "");
      const push = commitAndPush(work, 0);
      assert.equal(push.status, 0, push.stderr);
      assert.match(push.stderr, /in a clean temporary worktree/);
      const seen = readFileSync(log, "utf8");
      assert.match(seen, /cwd=.*diffci-push-/, "verification ran in the temporary worktree");
      assert.match(seen, /deps=linked/, "installed dependencies were linked in");
      assert.match(seen, /dirty=0/, "the stray file did not follow into the worktree");
      assert.match(seen, /args=verify --base [0-9a-f]{40} --head [0-9a-f]{40}/);
      assert.ok(existsSync(join(work, "node_modules", "marker", "KEEP")), "cleanup never deletes the real node_modules");
      assert.equal(git(work, "worktree", "list").split("\n").length, 1, "the temporary worktree is removed");
      assert.ok(existsSync(join(work, "True")), "the checkout itself is untouched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still blocks a failing verification from the temporary worktree", () => {
    const { root, work } = setup();
    try {
      writeFileSync(join(work, "True"), "");
      const push = commitAndPush(work, 1);
      assert.notEqual(push.status, 0);
      assert.match(push.stderr, /verification failed; push blocked/);
      assert.ok(existsSync(join(work, "node_modules", "marker", "KEEP")));
      assert.equal(git(work, "worktree", "list").split("\n").length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reuse dependencies when the lockfile differs from the pushed commit", () => {
    const { root, work, log } = setup();
    try {
      writeFileSync(join(work, "a.txt"), "2\n");
      git(work, "commit", "-q", "-am", "change");
      writeFileSync(join(work, "package-lock.json"), '{"changed":true}\n');
      const push = spawnSync("git", ["push", "origin", "main"], { cwd: work, encoding: "utf8", windowsHide: true, env: { ...process.env, STUB_EXIT: "0" } });
      assert.equal(push.status, 0, "could-not-verify lets the push through");
      assert.match(push.stderr, /package-lock\.json differs from the pushed commit/);
      assert.equal(existsSync(log), false, "verification did not run against mismatched dependencies");
      assert.ok(existsSync(join(work, "node_modules", "marker", "KEEP")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies in place when the checkout is clean", () => {
    const { root, work, log } = setup();
    try {
      const push = commitAndPush(work, 0);
      assert.equal(push.status, 0, push.stderr);
      assert.match(push.stderr, /before push/);
      assert.doesNotMatch(readFileSync(log, "utf8"), /diffci-push-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
