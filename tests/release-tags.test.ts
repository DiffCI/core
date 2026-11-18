// SPDX-License-Identifier: MIT
// npm run release:tag pushes the three release tags in one atomic push. A rejected push leaves the tags it
// created in the local clone, so running it again must recreate them instead of stopping on "already exists".
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/release-tags.mjs", import.meta.url));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Release Test",
  GIT_AUTHOR_EMAIL: "release@example.com",
  GIT_COMMITTER_NAME: "Release Test",
  GIT_COMMITTER_EMAIL: "release@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function releaseCheckout(version: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-release-tags-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", work);
  mkdirSync(join(work, "packages", "diffci-cli"), { recursive: true });
  writeFileSync(join(work, "packages", "diffci-cli", "package.json"), `${JSON.stringify({ version })}\n`);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "release");
  git(work, "branch", "-M", "main");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { root, work, head: git(work, "rev-parse", "HEAD") };
}

function releaseTag(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
}

function remoteTags(cwd: string): Map<string, string> {
  return new Map(git(cwd, "ls-remote", "--tags", "origin").split("\n").filter(Boolean).map((line) => {
    const [sha, ref] = line.split("\t");
    return [ref.replace(/^refs\/tags\//, ""), sha];
  }));
}

test("pushes the release, Action and CLI tags at the release commit", () => {
  const { root, work, head } = releaseCheckout("9.9.9");
  try {
    const result = releaseTag(work);
    assert.equal(result.status, 0, result.stderr);
    const tags = remoteTags(work);
    assert.equal(tags.get("v9.9.9"), head);
    assert.equal(tags.get("cli-release-v9.9.9"), head);
    assert.equal(tags.get("action-v9.9.9^{}"), head);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a rerun after a rejected push recreates the local tags it left behind", () => {
  const { root, work, head } = releaseCheckout("9.9.9");
  try {
    // What a rejected atomic push leaves behind: every tag exists locally, none on origin.
    git(work, "tag", "v9.9.9", head);
    git(work, "tag", "-a", "action-v9.9.9", "-m", "Release DiffCI observer Action v9.9.9", head);
    git(work, "tag", "cli-release-v9.9.9", head);
    const result = releaseTag(work);
    assert.equal(result.status, 0, result.stderr);
    const tags = remoteTags(work);
    assert.equal(tags.get("v9.9.9"), head);
    assert.equal(tags.get("cli-release-v9.9.9"), head);
    assert.equal(tags.get("action-v9.9.9^{}"), head);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
