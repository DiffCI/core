// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert";
import { describe, it } from "node:test";
import { computeAnalysis, gitDeltaToJson, hasRelevantPackageJsonChange, summarize } from "../../src/git/git-diff.js";
import type { ChangedFile } from "../../src/git/types.js";

describe("computeAnalysis", () => {
  it("flags workflow and config changes", () => {
    const files: ChangedFile[] = [
      { path: ".github/workflows/ci.yml", changeType: "modified" },
    ];
    const analysis = computeAnalysis(files);
    assert.strictEqual(analysis.workflowChanged, true);
    assert.strictEqual(analysis.configChanged, true);
    assert.strictEqual(analysis.lockfileChanged, false);
  });

  it("flags lockfile changes", () => {
    const files: ChangedFile[] = [
      { path: "package-lock.json", changeType: "modified" },
    ];
    const analysis = computeAnalysis(files);
    assert.strictEqual(analysis.dependencyManifestChanged, false);
    assert.strictEqual(analysis.lockfileChanged, true);
    assert.strictEqual(analysis.configChanged, true);
  });

  it("flags dependency manifest changes", () => {
    const files: ChangedFile[] = [
      { path: "package.json", changeType: "modified" },
    ];
    const analysis = computeAnalysis(files);
    assert.strictEqual(analysis.dependencyManifestChanged, true);
    assert.strictEqual(analysis.configChanged, true);
  });

  it("flags database and infrastructure changes", () => {
    const files: ChangedFile[] = [
      { path: "database/migrations/001.sql", changeType: "added" },
      { path: "ops/cloudflare/wrangler.toml", changeType: "modified" },
    ];
    const analysis = computeAnalysis(files);
    assert.strictEqual(analysis.databaseChanged, true);
    assert.strictEqual(analysis.infrastructureChanged, true);
    assert.strictEqual(analysis.configChanged, true);
  });
});

describe("summarize", () => {
  it("counts change types correctly", () => {
    const files: ChangedFile[] = [
      { path: "a.ts", changeType: "added" },
      { path: "b.ts", changeType: "modified" },
      { path: "c.ts", changeType: "deleted" },
      { path: "d.ts", changeType: "renamed" },
      { path: "e.ts", changeType: "unknown" },
    ];
    const summary = summarize(files);
    assert.deepStrictEqual(summary, {
      added: 1,
      modified: 1,
      deleted: 1,
      renamed: 1,
      copied: 0,
      unmerged: 0,
      unknown: 1,
      total: 5,
    });
  });
});

describe("gitDeltaToJson", () => {
  it("produces deterministic output", () => {
    const delta = {
      baseSha: "abc123",
      headSha: "def456",
      files: [{ path: "src/a.ts", changeType: "modified" as const }],
      directories: ["src"],
      summary: {
        added: 0,
        modified: 1,
        deleted: 0,
        renamed: 0,
        copied: 0,
        unmerged: 0,
        unknown: 0,
        total: 1,
      },
      analysis: {
        empty: false,
        configChanged: false,
        dependencyManifestChanged: false,
        lockfileChanged: false,
        workflowChanged: false,
        infrastructureChanged: false,
        databaseChanged: false,
      },
    };
    const first = gitDeltaToJson(delta);
    const second = gitDeltaToJson(delta);
    assert.strictEqual(first, second);
  });
});

// Stage 1B unit tests (2026-08-21, docs/research/2026-08-21-stage1b-*.md) for the pure field-comparison
// logic in isolation - see git-diff.temp-repo.test.ts for the real-git-repo end-to-end version wired
// through analyzeGitDelta.
describe("hasRelevantPackageJsonChange", () => {
  it("returns false when only metadata fields differ", () => {
    const oldJson = JSON.stringify({ name: "x", description: "old", author: "a", keywords: ["a"] });
    const newJson = JSON.stringify({ name: "x", description: "new", author: "b", keywords: ["b", "c"] });
    assert.strictEqual(hasRelevantPackageJsonChange(oldJson, newJson), false);
  });

  it("returns true when dependencies change", () => {
    const oldJson = JSON.stringify({ name: "x", dependencies: { a: "1.0.0" } });
    const newJson = JSON.stringify({ name: "x", dependencies: { a: "2.0.0" } });
    assert.strictEqual(hasRelevantPackageJsonChange(oldJson, newJson), true);
  });

  it("returns true when scripts change", () => {
    const oldJson = JSON.stringify({ name: "x", scripts: { test: "vitest" } });
    const newJson = JSON.stringify({ name: "x", scripts: { test: "jest" } });
    assert.strictEqual(hasRelevantPackageJsonChange(oldJson, newJson), true);
  });

  it("returns true when either side is missing (added/deleted, nothing to narrow against)", () => {
    assert.strictEqual(hasRelevantPackageJsonChange(undefined, JSON.stringify({ name: "x" })), true);
    assert.strictEqual(hasRelevantPackageJsonChange(JSON.stringify({ name: "x" }), undefined), true);
  });

  it("returns true (fails safe) when either side is unparseable JSON", () => {
    assert.strictEqual(hasRelevantPackageJsonChange("{not valid json", JSON.stringify({ name: "x" })), true);
    assert.strictEqual(hasRelevantPackageJsonChange(JSON.stringify({ name: "x" }), "{not valid json"), true);
  });

  it("returns false for byte-identical content", () => {
    const json = JSON.stringify({ name: "x", dependencies: { a: "1.0.0" } });
    assert.strictEqual(hasRelevantPackageJsonChange(json, json), false);
  });
});
