/**
 * Shallow CI clones (2026-11-08): the CLI fetches the history it compares, as the Action does since
 * v0.3.36, so a CLI step no longer needs `fetch-depth: 0`. Driven against real git: a depth-1 clone of a
 * local repository is what `actions/checkout` leaves by default.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { resolveCommitRangeFetchingHistory } from "../../src/client/context.js";
import { makeGitRunner } from "../../src/client/observe.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function shallowClone() {
  const root = mkdtempSync(join(tmpdir(), "diffci-shallow-"));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  const shas: string[] = [];
  for (const n of [1, 2, 3]) {
    writeFileSync(join(origin, "a.txt"), `${n}\n`);
    git(origin, "add", "-A");
    git(origin, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", `c${n}`);
    shas.push(git(origin, "rev-parse", "HEAD"));
  }
  const clone = join(root, "clone");
  // file:// URL: git ignores --depth for a plain local path.
  execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(origin).href, clone]);
  return { root, clone, base: shas[0]!, head: shas[2]! };
}

describe("shallow CI clones", () => {
  it("fetches the missing history in CI and resolves the range", () => {
    const { root, clone, base, head } = shallowClone();
    try {
      const status = git(clone, "status", "--porcelain");
      const resolved = resolveCommitRangeFetchingHistory({
        env: { GITHUB_ACTIONS: "true" }, git: makeGitRunner(clone), baseOverride: base, headOverride: head,
      });
      assert.ok(resolved.ok, resolved.ok ? "" : resolved.reason);
      assert.equal(resolved.range.baseSha, base);
      assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "false");
      assert.equal(git(clone, "rev-parse", "HEAD"), head, "HEAD did not move");
      assert.equal(git(clone, "status", "--porcelain"), status, "the checkout is unchanged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #278: e.g. actions/checkout with `path: target` while DiffCI observes the workspace above it.
  it("points a path that is not a git checkout at repository-path, not fetch-depth", () => {
    const root = mkdtempSync(join(tmpdir(), "diffci-not-checkout-"));
    try {
      const event = join(root, "event.json");
      writeFileSync(event, JSON.stringify({ pull_request: { number: 1, base: { sha: "b".repeat(40) }, head: { sha: "a".repeat(40) } } }));
      const github = resolveCommitRangeFetchingHistory({
        env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event }, git: makeGitRunner(root),
      });
      assert.equal(github.ok, false);
      const reason = github.ok ? "" : github.reason;
      assert.match(reason, /not a git checkout/);
      assert.match(reason, /`repository-path`/);
      assert.doesNotMatch(reason, /fetch-depth/);

      const azure = resolveCommitRangeFetchingHistory({ env: { TF_BUILD: "True", BUILD_REASON: "Manual" }, git: makeGitRunner(root) });
      assert.match(azure.ok ? "" : azure.reason, /`repositoryPath`/);
      const local = resolveCommitRangeFetchingHistory({ env: {}, git: makeGitRunner(root) });
      assert.match(local.ok ? "" : local.reason, /not a git checkout: pass `--repo`/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never fetches into a local clone", () => {
    const { root, clone, base, head } = shallowClone();
    try {
      const resolved = resolveCommitRangeFetchingHistory({ env: {}, git: makeGitRunner(clone), baseOverride: base, headOverride: head });
      assert.equal(resolved.ok, false);
      assert.match(resolved.ok ? "" : resolved.reason, /fetch-depth: 0/);
      assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the fetch-depth hint and says why when the fetch fails", () => {
    const { root, clone, base, head } = shallowClone();
    try {
      git(clone, "remote", "set-url", "origin", pathToFileURL(join(root, "missing")).href);
      const resolved = resolveCommitRangeFetchingHistory({ env: { GITLAB_CI: "true" }, git: makeGitRunner(clone), baseOverride: base, headOverride: head });
      assert.equal(resolved.ok, false);
      assert.match(resolved.ok ? "" : resolved.reason, /GIT_DEPTH: "0".*\(fetching the full history failed: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
