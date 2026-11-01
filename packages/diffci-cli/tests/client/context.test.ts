/**
 * Phase 02 (2026-08-26): the commit range must be recovered from the environment or refused.
 *
 * Each case here is a way the environment offers a plausible range that answers the wrong question -
 * a shallow checkout missing the base, a branch's first push whose `before` is forty zeros, a workflow
 * trigger with no range at all. The engine downstream cannot tell any of them from a real range, so
 * the refusal has to happen here.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readCiEnvironment, resolveCommitRange, type GitRunner } from "../../src/client/context.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const ZERO = "0".repeat(40);

/** A git that knows about exactly the commits it is told about, and nothing else. */
function fakeGit(options: { known?: string[]; revs?: Record<string, string>; mergeBase?: string }): GitRunner {
  const known = new Set(options.known ?? []);
  return (args) => {
    if (args[0] === "cat-file") {
      const sha = (args[2] ?? "").replace("^{commit}", "");
      return known.has(sha) ? { ok: true, stdout: "" } : { ok: false, error: "not found" };
    }
    if (args[0] === "rev-parse") {
      // Mirrors the real call shape: `rev-parse --verify <rev>^{commit}`.
      const rev = (args[args.length - 1] ?? "").replace("^{commit}", "");
      const value = options.revs?.[rev];
      return value ? { ok: true, stdout: `${value}\n` } : { ok: false, error: "bad revision" };
    }
    if (args[0] === "merge-base") {
      return options.mergeBase ? { ok: true, stdout: `${options.mergeBase}\n` } : { ok: false, error: "no merge base" };
    }
    return { ok: false, error: `unexpected git ${args.join(" ")}` };
  };
}

function withEventPayload(payload: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "diffci-event-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify(payload));
  return { dir, path };
}

describe("CI environment facts", () => {
  it("reports a local run when GITHUB_ACTIONS is absent", () => {
    assert.equal(readCiEnvironment({}).provider, "local");
  });

  it("marks schedule and workflow_dispatch as synthetic triggers", () => {
    const facts = readCiEnvironment({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "schedule" });
    assert.equal(facts.syntheticTrigger, true);
    assert.equal(readCiEnvironment({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" }).syntheticTrigger, false);
  });
});

describe("commit range resolution", () => {
  it("uses explicit flags as given", () => {
    const result = resolveCommitRange({
      env: {},
      git: fakeGit({ revs: { x: BASE, y: HEAD } }),
      baseOverride: "x",
      headOverride: "y",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      { base: result.range.baseSha, head: result.range.headSha, source: result.range.source },
      { base: BASE, head: HEAD, source: "explicit-flags" },
    );
  });

  it("refuses when only one of --base/--head is given", () => {
    const result = resolveCommitRange({ env: {}, git: fakeGit({}), headOverride: HEAD });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /must be given together/);
  });

  it("prefers the merge base on a pull request, and records that it did", () => {
    const event = withEventPayload({ pull_request: { head: { sha: HEAD }, base: { sha: BASE } } });
    try {
      const result = resolveCommitRange({
        env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event.path },
        git: fakeGit({ known: [HEAD, BASE], mergeBase: MERGE_BASE }),
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.range.baseSha, MERGE_BASE);
      assert.equal(result.range.mergeBaseSha, MERGE_BASE);
      assert.equal(result.range.source, "pull-request-event");
    } finally {
      rmSync(event.dir, { recursive: true, force: true });
    }
  });

  it("refuses a pull request whose base is missing from a shallow checkout, and says how to fix it", () => {
    const event = withEventPayload({ pull_request: { head: { sha: HEAD }, base: { sha: BASE } } });
    try {
      const result = resolveCommitRange({
        env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event.path },
        git: fakeGit({ known: [HEAD] }),
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /fetch-depth: 0/);
    } finally {
      rmSync(event.dir, { recursive: true, force: true });
    }
  });

  it("never treats a zero `before` as a commit - it falls back to the head's parent and labels it", () => {
    const event = withEventPayload({ before: ZERO });
    try {
      const result = resolveCommitRange({
        env: { GITHUB_EVENT_NAME: "push", GITHUB_SHA: HEAD, GITHUB_EVENT_PATH: event.path },
        git: fakeGit({ known: [HEAD], revs: { [`${HEAD}^`]: BASE } }),
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.range.baseSha, BASE);
      assert.equal(result.range.source, "head-parent");
    } finally {
      rmSync(event.dir, { recursive: true, force: true });
    }
  });

  it("refuses a first push whose head has no parent, rather than diffing against nothing", () => {
    const event = withEventPayload({ before: ZERO });
    try {
      const result = resolveCommitRange({
        env: { GITHUB_EVENT_NAME: "push", GITHUB_SHA: HEAD, GITHUB_EVENT_PATH: event.path },
        git: fakeGit({ known: [HEAD] }),
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /no parent/);
    } finally {
      rmSync(event.dir, { recursive: true, force: true });
    }
  });

  it("uses the push event's `before` when it is real and present locally", () => {
    const event = withEventPayload({ before: BASE });
    try {
      const result = resolveCommitRange({
        env: { GITHUB_EVENT_NAME: "push", GITHUB_SHA: HEAD, GITHUB_EVENT_PATH: event.path },
        git: fakeGit({ known: [HEAD, BASE] }),
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.range.baseSha, BASE);
      assert.equal(result.range.source, "push-event");
    } finally {
      rmSync(event.dir, { recursive: true, force: true });
    }
  });

  it("refuses outside a git repository instead of inventing a range", () => {
    const result = resolveCommitRange({ env: {}, git: fakeGit({}) });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /not a git repository/);
  });
});
