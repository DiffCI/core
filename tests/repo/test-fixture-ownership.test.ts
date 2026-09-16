// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveTestFixtureOwners } from "../../src/repo/test-fixture-ownership.js";
import { createTestFileMatcher, DEFAULT_TEST_PATTERNS } from "../../src/repo/test-discovery.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { DependencyGraph, DependencyGraphResult, RepositoryProfile } from "../../src/repo/types.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";

// Universe like deepseek-harness: snapshot/e2e declared by configs, plus conventional spec files.
const PATTERNS = [...DEFAULT_TEST_PATTERNS, "examples/*/tests/**/*.snapshot.ts", "examples/*/tests/**/*.e2e.ts", "apps/web/tests/**/*.snapshot.ts"];
const isTest = createTestFileMatcher(PATTERNS);
const HEAD = new Set([
  "examples/acp-agent/tests/acp.snapshot.ts",
  "examples/acp-agent/tests/acp.e2e.ts",
  "examples/acp-agent/tests/cleanup.e2e.ts",
  "examples/acp-agent/tests/fixtures/subagent-result-diagnostic.ts",
  "examples/acp-agent/tests/snapshots/fs-read/session.jsonl",
  "examples/acp-agent/tests/goal-snapshots/goal-wrapup/session.expected.jsonl",
  "examples/headless-agent/tests/headless.snapshot.ts",
  "examples/headless-agent/tests/nested/deep.spec.ts",
  "examples/headless-agent/tests/subagent-inheritance-snapshots/parent-override/child.replay.jsonl",
  "packages/test-support/acp-snapshot/tests/fixtures/suite/plain-turn/session.jsonl",
  "packages/test-support/acp-snapshot/tests/suite.spec.ts",
  "packages/test-support/acp-snapshot/tests/record.spec.ts",
  "packages/only-nested/tests/unit/a.spec.ts",
  "packages/only-nested/tests/fixtures/x.jsonl",
  "packages/empty/tests/fixtures/x.jsonl",
  "packages/empty/tests/helper.ts",
  "scripts/snapshots/python-sdk-single-exe/advanced/session.jsonl",
  "packages/session/data/events.jsonl",
  "examples/acp-agent/tests/notes/readme.jsonl",
]);

describe("resolveTestFixtureOwners", () => {
  it("exact: a snapshots/ fixture is owned by the snapshot-family suite beside it, not the e2e suites", () => {
    const o = resolveTestFixtureOwners("examples/acp-agent/tests/snapshots/fs-read/session.jsonl", isTest, HEAD);
    assert.deepStrictEqual(o, { testsDir: "examples/acp-agent/tests", fixtureDir: "examples/acp-agent/tests/snapshots", scope: "direct-snapshot-family", owners: ["examples/acp-agent/tests/acp.snapshot.ts"] });
    const g = resolveTestFixtureOwners("examples/acp-agent/tests/goal-snapshots/goal-wrapup/session.expected.jsonl", isTest, HEAD);
    assert.deepStrictEqual(g?.owners, ["examples/acp-agent/tests/acp.snapshot.ts"]);
    assert.deepStrictEqual(resolveTestFixtureOwners("examples/headless-agent/tests/subagent-inheritance-snapshots/parent-override/child.replay.jsonl", isTest, HEAD)?.owners, ["examples/headless-agent/tests/headless.snapshot.ts"]);
  });

  it("conservative package-level: a fixtures/ dir is owned by ALL direct test children of the tests dir", () => {
    const o = resolveTestFixtureOwners("packages/test-support/acp-snapshot/tests/fixtures/suite/plain-turn/session.jsonl", isTest, HEAD);
    assert.strictEqual(o?.scope, "direct");
    assert.deepStrictEqual(o?.owners, ["packages/test-support/acp-snapshot/tests/record.spec.ts", "packages/test-support/acp-snapshot/tests/suite.spec.ts"]);
  });

  it("ambiguous: no direct test children -> every recognised test under the tests dir (wider superset)", () => {
    const o = resolveTestFixtureOwners("packages/only-nested/tests/fixtures/x.jsonl", isTest, HEAD);
    assert.strictEqual(o?.scope, "recursive");
    assert.deepStrictEqual(o?.owners, ["packages/only-nested/tests/unit/a.spec.ts"]);
  });

  it("no safe owner -> undefined (stays unknown): no tests in the dir, no tests dir, non-fixture dir, runtime data, a test file itself, no inventory", () => {
    assert.strictEqual(resolveTestFixtureOwners("packages/empty/tests/fixtures/x.jsonl", isTest, HEAD), undefined, "tests dir has only a helper");
    assert.strictEqual(resolveTestFixtureOwners("scripts/snapshots/python-sdk-single-exe/advanced/session.jsonl", isTest, HEAD), undefined, "no tests dir ancestor");
    assert.strictEqual(resolveTestFixtureOwners("examples/acp-agent/tests/notes/readme.jsonl", isTest, HEAD), undefined, "notes/ is not a fixture dir");
    assert.strictEqual(resolveTestFixtureOwners("packages/session/data/events.jsonl", isTest, HEAD), undefined, "unrelated runtime .jsonl");
    assert.strictEqual(resolveTestFixtureOwners("examples/acp-agent/tests/snapshots", isTest, HEAD), undefined, "the fixture dir itself, no file segment");
    assert.strictEqual(resolveTestFixtureOwners("examples/acp-agent/tests/acp.snapshot.ts", isTest, HEAD), undefined, "a test is not a fixture");
    assert.strictEqual(resolveTestFixtureOwners("examples/acp-agent/tests/snapshots/fs-read/session.jsonl", isTest, undefined), undefined, "no HEAD inventory");
  });

  it("deleted fixture: resolves against HEAD - owners still selected while the tests dir exists; unknown once it is gone", () => {
    const deletedPath = "examples/acp-agent/tests/snapshots/removed-case/session.jsonl"; // not in HEAD
    assert.deepStrictEqual(resolveTestFixtureOwners(deletedPath, isTest, HEAD)?.owners, ["examples/acp-agent/tests/acp.snapshot.ts"]);
    const headWithoutSuite = new Set([...HEAD].filter((f) => !f.startsWith("examples/acp-agent/tests/")));
    assert.strictEqual(resolveTestFixtureOwners(deletedPath, isTest, headWithoutSuite), undefined);
  });
});

// ---- through the analyzer: category, selection, evidence, rename and fallback semantics ----
function graphOf(paths: string[]): DependencyGraphResult {
  const nodes = paths.map((p) => ({ path: p, isSource: true, isAsset: false, isTest: isTest(p), isEntryPoint: false }));
  const graph: DependencyGraph = { nodes, edges: [], dependentsOf: () => [], dependenciesOf: () => [], transitiveDependentsOf: () => [], transitiveDependenciesOf: () => [] } as unknown as DependencyGraph;
  return { graph, profile: profile(), unresolved: [], performance: { durationMs: 0, filesDiscovered: nodes.length, filesParsed: nodes.length }, confidence: "HIGH", integrity: { findings: [], criticalCount: 0, warningCount: 0, stats: { nodeCount: nodes.length, sourceNodeCount: nodes.length, assetNodeCount: 0, edgeCount: 0, assetEdgeCount: 0 } }, resolvedViaProjectReferences: false } as unknown as DependencyGraphResult;
}
function profile(): RepositoryProfile {
  return { packageManager: "pnpm", packageJson: { name: "t", version: "1", scripts: {}, dependencies: [], devDependencies: [] }, sourceRoots: [], tests: [], testFilePaths: [...HEAD].filter(isTest), testPatterns: PATTERNS, workflows: [], configFiles: [], pathAliases: [], entryPoints: [], nextConfig: { exists: false }, stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 } };
}
function delta(files: ChangedFile[]): GitDelta {
  return { baseSha: "b", headSha: "h", files, directories: [], summary: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: files.length }, analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false } };
}
const analyze = (files: ChangedFile[], repositoryFiles: ReadonlySet<string> | null = HEAD) => new ImpactAnalyzer().analyze(delta(files), graphOf([...HEAD].filter(isTest)), profile(), { repositoryFiles: repositoryFiles ?? undefined });

describe("ImpactAnalyzer with test-fixture ownership", () => {
  it("a modified snapshot fixture selects its owning suite with TEST_FIXTURE_OWNER and no fallback; never classified as docs", () => {
    const r = analyze([{ path: "examples/acp-agent/tests/snapshots/fs-read/session.jsonl", changeType: "modified" }]);
    assert.strictEqual(r.fallbackRequired, false, JSON.stringify(r.fallbackReasons));
    assert.strictEqual(r.changedFiles[0]?.category, "test-fixture");
    assert.deepStrictEqual(r.affectedTests.map((t) => t.path), ["examples/acp-agent/tests/acp.snapshot.ts"]);
    assert.ok(r.affectedTests[0]?.reasons.includes("TEST_FIXTURE_OWNER"));
    assert.ok(r.evidence.some((e) => e.reason === "TEST_FIXTURE_OWNER" && e.message.includes("direct-snapshot-family")));
  });

  it("renamed fixture: both sides resolve to owners (union); a rename OUT of any owned location falls back", () => {
    const ok = analyze([{ path: "examples/acp-agent/tests/snapshots/fs-read-v2/session.jsonl", oldPath: "examples/acp-agent/tests/snapshots/fs-read/session.jsonl", changeType: "renamed" }]);
    assert.strictEqual(ok.fallbackRequired, false, JSON.stringify(ok.fallbackReasons));
    assert.deepStrictEqual(ok.affectedTests.map((t) => t.path), ["examples/acp-agent/tests/acp.snapshot.ts"]);
    const across = analyze([{ path: "packages/test-support/acp-snapshot/tests/fixtures/moved/session.jsonl", oldPath: "examples/acp-agent/tests/snapshots/fs-read/session.jsonl", changeType: "renamed" }]);
    assert.strictEqual(across.fallbackRequired, false);
    assert.deepStrictEqual(across.affectedTests.map((t) => t.path).sort(), ["examples/acp-agent/tests/acp.snapshot.ts", "packages/test-support/acp-snapshot/tests/record.spec.ts", "packages/test-support/acp-snapshot/tests/suite.spec.ts"]);
    const out = analyze([{ path: "packages/session/data/events.jsonl", oldPath: "examples/acp-agent/tests/snapshots/fs-read/session.jsonl", changeType: "renamed" }]);
    assert.strictEqual(out.fallbackRequired, true);
    assert.ok(out.riskSignals.some((s) => s.reason === "UNKNOWN_FILE"));
  });

  it("deleted fixture selects the surviving owner; unrelated .jsonl and missing inventory fall back", () => {
    const del = analyze([{ path: "examples/acp-agent/tests/snapshots/gone/session.jsonl", changeType: "deleted" }]);
    assert.strictEqual(del.fallbackRequired, false);
    assert.deepStrictEqual(del.affectedTests.map((t) => t.path), ["examples/acp-agent/tests/acp.snapshot.ts"]);
    const unrelated = analyze([{ path: "packages/session/data/events.jsonl", changeType: "modified" }]);
    assert.strictEqual(unrelated.fallbackRequired, true);
    assert.strictEqual(unrelated.changedFiles[0]?.category, "unknown");
    const noInv = analyze([{ path: "examples/acp-agent/tests/snapshots/fs-read/session.jsonl", changeType: "modified" }], null);
    assert.strictEqual(noInv.fallbackRequired, true);
    assert.strictEqual(noInv.changedFiles[0]?.category, "unknown");
  });
});
