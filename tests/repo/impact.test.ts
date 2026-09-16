// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ImpactAnalyzer, directlyChangedExecutableTests } from "../../src/repo/impact.js";
import type { DependencyGraph, DependencyGraphNode, DependencyGraphResult, RepositoryProfile } from "../../src/repo/types.js";
import type { ChangedFile, GitDelta, GitDeltaSummary } from "../../src/git/types.js";

function makeNodes(paths: string[]): DependencyGraphNode[] {
  return paths.map((p) => ({
    path: p,
    isSource: /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p),
    isAsset: !/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p),
    isTest: /\.(test|spec)\./.test(p),
    isEntryPoint: /\/(page|layout|route|api)\.(tsx|ts|jsx|js)$/.test(p),
  }));
}

function makeGraph(paths: string[], edges: Array<[string, string]>): DependencyGraph {
  const nodes = makeNodes(paths);
  const forward: Record<string, string[]> = {};
  const reverse: Record<string, string[]> = {};
  for (const [from, to] of edges) {
    (forward[from] ??= []).push(to);
    (reverse[to] ??= []).push(from);
  }
  const adj = (map: Record<string, string[]>, p: string, visited: Set<string>, result: string[]) => {
    if (visited.has(p)) return;
    visited.add(p);
    for (const next of map[p] ?? []) {
      if (!result.includes(next)) result.push(next);
      adj(map, next, visited, result);
    }
  };
  const collect = (map: Record<string, string[]>, p: string) => {
    const result: string[] = [];
    adj(map, p, new Set(), result);
    return result;
  };
  return {
    nodes,
    edges: edges.map(([from, to]) => ({ from, to, kind: "import" as const })),
    forward,
    reverse,
    dependenciesOf: (p) => collect(forward, p),
    dependentsOf: (p) => collect(reverse, p),
    transitiveDependenciesOf: (p) => collect(forward, p),
    transitiveDependentsOf: (p) => collect(reverse, p),
  };
}

function makeDependencyGraphResult(graph: DependencyGraph, confidence: DependencyGraphResult["confidence"] = "COMPLETE"): DependencyGraphResult {
  return {
    graph,
    profile: makeProfile(),
    unresolved: [],
    references: [],
    counts: { internalSource: 0, internalAsset: 0, externalPackage: 0, platformBuiltin: 0, unresolved: 0 },
    externalReferences: 0,
    platformBuiltinReferences: 0,
    internalAssetEdges: 0,
    performance: { durationMs: 0, filesDiscovered: graph.nodes.length, filesParsed: graph.nodes.length },
    confidence,
    integrity: { findings: [], criticalCount: 0, warningCount: 0, stats: { nodeCount: graph.nodes.length, sourceNodeCount: 0, assetNodeCount: 0, edgeCount: graph.edges.length, assetEdgeCount: 0 } },
    resolvedViaProjectReferences: false,
  };
}

function makeProfile(options: { next?: boolean; entryPoints?: string[]; tests?: string[] } = {}): RepositoryProfile {
  const nextConfig = options.next ? { exists: true, file: "next.config.ts" } : { exists: false };
  const entryPoints = (options.entryPoints ?? []).map((p) => ({ path: p, kind: /layout\.(tsx|ts|jsx|js)$/.test(p) ? ("next-layout" as const) : /api\//.test(p) ? ("next-api" as const) : ("next-page" as const) }));
  const testGlobs = options.tests ?? ["src/**/*.test.ts"];
  const tests = testGlobs.map((g) => ({ glob: g, count: 1 }));
  return {
    packageManager: "npm",
    packageJson: { name: "test", version: "1.0.0", scripts: {}, dependencies: [], devDependencies: [] },
    sourceRoots: [],
    tests,
    testFilePaths: [],
    workflows: [],
    configFiles: [],
    pathAliases: [],
    entryPoints,
    nextConfig,
    stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 },
  };
}

function makeDelta(base: string, head: string, files: ChangedFile[], analysis: Partial<GitDelta["analysis"]>, summary: Partial<GitDeltaSummary> = {}): GitDelta {
  const fullSummary = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: files.length, ...summary };
  const fullAnalysis = {
    empty: files.length === 0,
    configChanged: false,
    dependencyManifestChanged: false,
    lockfileChanged: false,
    workflowChanged: false,
    infrastructureChanged: false,
    databaseChanged: false,
    ...analysis,
  };
  return { baseSha: base, headSha: head, files, directories: [], summary: fullSummary, analysis: fullAnalysis };
}

const analyzer = new ImpactAnalyzer([]);

describe("ImpactAnalyzer synthetic cases", () => {

  it("A: pure source change selects dependent test", () => {
    const graph = makeGraph(
      ["src/lib/util.ts", "src/app/page.tsx", "src/lib/util.test.ts"],
      [
        ["src/app/page.tsx", "src/lib/util.ts"],
        ["src/lib/util.test.ts", "src/lib/util.ts"],
      ],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/page.tsx"] });
    const delta = makeDelta("base", "head", [{ path: "src/lib/util.ts", changeType: "modified" }], {});
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedSourceFiles.sort(), ["src/app/page.tsx", "src/lib/util.ts"]);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path), ["src/lib/util.test.ts"]);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path), ["src/app/page.tsx"]);
  });

  it("B: asset change reaches source, entry point, and test", () => {
    const graph = makeGraph(
      ["src/styles.module.css", "src/app/page.tsx", "src/app/page.test.tsx"],
      [
        ["src/app/page.tsx", "src/styles.module.css"],
        ["src/app/page.test.tsx", "src/app/page.tsx"],
      ],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/page.tsx"] });
    const delta = makeDelta("base", "head", [{ path: "src/styles.module.css", changeType: "modified" }], {});
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedAssets, ["src/styles.module.css"]);
    assert.deepStrictEqual(result.affectedSourceFiles.sort(), ["src/app/page.tsx"]);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path), ["src/app/page.test.tsx"]);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path), ["src/app/page.tsx"]);
  });

  it("C: Next.js layout change impacts descendant entry points", () => {
    const graph = makeGraph(
      ["src/app/layout.tsx", "src/app/page.tsx", "src/app/blog/page.tsx", "src/app/blog/post/page.tsx"],
      [],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/layout.tsx", "src/app/page.tsx", "src/app/blog/page.tsx", "src/app/blog/post/page.tsx"] });
    const delta = makeDelta("base", "head", [{ path: "src/app/layout.tsx", changeType: "modified" }], {});
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path).sort(), [
      "src/app/blog/page.tsx",
      "src/app/blog/post/page.tsx",
      "src/app/layout.tsx",
      "src/app/page.tsx",
    ]);
    assert.ok(result.evidence.some((e) => e.reason === "NEXT_LAYOUT_ANCESTOR"));
  });

  it("D: added entry point is flagged", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile({ next: true, entryPoints: [] });
    const delta = makeDelta("base", "head", [{ path: "src/app/page.tsx", changeType: "added" }], {}, { added: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path), ["src/app/page.tsx"]);
    assert.ok(result.evidence.some((e) => e.reason === "NEW_ENTRY_POINT"));
  });

  it("E: config change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "package.json", changeType: "modified" }], { configChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "CONFIG_GLOBAL"));
  });

  it("F: deleted source not in graph falls back", () => {
    const graph = makeGraph(["src/lib/other.ts"], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/deleted.ts", changeType: "deleted" }], {}, { deleted: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "DELETED_FILE_UNKNOWABLE_GRAPH"));
  });

  it("G: graph confidence UNSAFE falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/util.ts", changeType: "modified" }], {}, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph, "UNSAFE"), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "GRAPH_CONFIDENCE_UNSAFE"));
  });

  it("H: empty delta is safe with no affected files", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [], { empty: true });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedTests, []);
    assert.deepStrictEqual(result.affectedEntryPoints, []);
    assert.ok(result.riskSignals.some((s) => s.reason === "EMPTY_DELTA"));
  });

  it("I: unknown file falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/weird.unknown", changeType: "modified" }], {}, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "UNKNOWN_FILE"));
  });

  it("J: infrastructure change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "ops/main.tf", changeType: "modified" }], { infrastructureChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "INFRASTRUCTURE_GLOBAL"));
  });

  it("K: database change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "database/migrations/001.sql", changeType: "modified" }], { databaseChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "DATABASE_GLOBAL"));
  });

  it("L: lockfile change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "package-lock.json", changeType: "modified" }], { lockfileChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "LOCKFILE_GLOBAL"));
  });

  it("M: multiple changes union", () => {
    const graph = makeGraph(
      ["src/lib/util.ts", "src/app/page.tsx", "src/lib/util.test.ts", "src/styles.module.css", "src/app/page.test.tsx"],
      [
        ["src/app/page.tsx", "src/lib/util.ts"],
        ["src/lib/util.test.ts", "src/lib/util.ts"],
        ["src/app/page.tsx", "src/styles.module.css"],
        ["src/app/page.test.tsx", "src/app/page.tsx"],
      ],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/page.tsx"] });
    const delta = makeDelta("base", "head", [
      { path: "src/lib/util.ts", changeType: "modified" },
      { path: "src/styles.module.css", changeType: "modified" },
    ], {}, { modified: 2 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedSourceFiles.sort(), ["src/app/page.tsx", "src/lib/util.ts"]);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path).sort(), ["src/app/page.test.tsx", "src/lib/util.test.ts"]);
  });

  it("N: always-run security tests are included", () => {
    const graph = makeGraph(["scripts/test-security.js", "src/lib/util.ts"], [["scripts/test-security.js", "src/lib/util.ts"]]);
    const profile = makeProfile({ tests: ["src/**/*.test.ts", "scripts/*.js"] });
    const custom = new ImpactAnalyzer([
      { name: "security", reason: "ALWAYS_RUN_POLICY", patterns: [/test-security\.js$/] },
    ]);
    const delta = makeDelta("base", "head", [{ path: "src/lib/util.ts", changeType: "modified" }], {}, { modified: 1 });
    const result = custom.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.ok(result.affectedTests.some((t) => t.path === "scripts/test-security.js"));
  });
});


describe("translated-documentation companion classification (2026-08-23, deepseek-harness benchmark)", () => {
  const analyzer = new ImpactAnalyzer();
  const run = (files: ChangedFile[], repositoryFiles?: ReadonlySet<string>, analysis: Partial<GitDelta["analysis"]> = {}) => {
    const delta = makeDelta("base", "head", files, analysis, { modified: files.length });
    return analyzer.analyze(delta, makeDependencyGraphResult(makeGraph([], [])), makeProfile(), repositoryFiles ? { repositoryFiles } : undefined);
  };
  const unknownSignal = (r: ReturnType<typeof analyzer.analyze>) => r.riskSignals.some((s) => s.reason === "UNKNOWN_FILE");

  it("accepts `<doc>.i18n.yaml` beside an existing `<doc>.md` as docs (no fallback, nothing selected)", () => {
    const repo = new Set(["packages/llm/README.md", "packages/llm/README.zh.md", "packages/llm/README.i18n.yaml"]);
    const result = run([{ path: "packages/llm/README.i18n.yaml", changeType: "modified" }], repo);
    assert.strictEqual(result.fallbackRequired, false);
    assert.strictEqual(unknownSignal(result), false);
    assert.deepStrictEqual(result.affectedTests, []);
    assert.strictEqual(result.changedFiles[0]?.category, "docs");
  });

  it("accepts the other translation-metadata tags and an .mdx companion, at repo root too", () => {
    const repo = new Set(["README.md", "docs/guide.mdx"]);
    for (const path of ["README.l10n.yaml", "README.translations.yml", "docs/guide.translation.yaml"]) {
      const result = run([{ path, changeType: "added" }], repo);
      assert.strictEqual(result.fallbackRequired, false, path);
    }
  });

  it("is inert when the caller supplies no repository file list (prior behavior preserved)", () => {
    const result = run([{ path: "packages/llm/README.i18n.yaml", changeType: "modified" }]);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(unknownSignal(result));
  });

  it("requires the Markdown companion to exist at HEAD - a lone or orphaned record stays unknown", () => {
    const noCompanion = run([{ path: "packages/llm/README.i18n.yaml", changeType: "modified" }], new Set(["packages/llm/README.zh.md"]));
    assert.strictEqual(noCompanion.fallbackRequired, true);
    assert.ok(unknownSignal(noCompanion));
    const wrongDir = run([{ path: "packages/llm/README.i18n.yaml", changeType: "modified" }], new Set(["packages/README.md", "README.md"]));
    assert.strictEqual(wrongDir.fallbackRequired, true);
  });

  it("leaves ordinary YAML configuration unsafe even when a same-stem Markdown file exists", () => {
    const repo = new Set(["config.md", "config.yaml", "app/settings.md", "app/settings.prod.yaml", "locales/en.yaml", "locales/en.md"]);
    for (const path of ["config.yaml", "app/settings.prod.yaml", "locales/en.yaml"]) {
      const result = run([{ path, changeType: "modified" }], repo);
      assert.strictEqual(result.fallbackRequired, true, path);
      assert.ok(unknownSignal(result), path);
    }
  });

  it("does not treat a locale-code tag as translation metadata (`guide.en.yaml` may be runtime content)", () => {
    // (not under docs/ - that prefix is already docs by the pre-existing isDocumentationFile rule)
    const result = run([{ path: "website/guide.en.yaml", changeType: "modified" }], new Set(["website/guide.md"]));
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(unknownSignal(result));
  });

  it("keeps misleading names in config/infra locations on their stricter classification", () => {
    const repo = new Set([".github/README.md", "docker/README.md", "ops/README.md"]);
    const gh = run([{ path: ".github/README.i18n.yaml", changeType: "modified" }], repo, { configChanged: true });
    assert.strictEqual(gh.fallbackRequired, true);
    assert.strictEqual(gh.changedFiles[0]?.category, "config");
    const ops = run([{ path: "ops/README.i18n.yaml", changeType: "modified" }], repo, { infrastructureChanged: true });
    assert.strictEqual(ops.fallbackRequired, true);
    assert.strictEqual(ops.changedFiles[0]?.category, "infrastructure");
  });

  it("mixed change: an accepted companion does not suppress another fallback trigger in the same delta", () => {
    const repo = new Set(["packages/llm/README.md", "pnpm-lock.yaml"]);
    const result = run(
      [{ path: "packages/llm/README.i18n.yaml", changeType: "modified" }, { path: "pnpm-lock.yaml", changeType: "modified" }],
      repo,
      { lockfileChanged: true, configChanged: true },
    );
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "LOCKFILE_GLOBAL"));
    const withUnknown = run([{ path: "packages/llm/README.i18n.yaml", changeType: "modified" }, { path: "examples/x/tests/snapshots/a/session.jsonl", changeType: "modified" }], repo);
    assert.strictEqual(withUnknown.fallbackRequired, true);
    assert.ok(unknownSignal(withUnknown));
  });
});
describe("changed-test self-selection (2026-08-24)", () => {
  const analyzer = new ImpactAnalyzer();

  it("selects a modified test file itself via DIRECT_TEST_CHANGE without falling back", () => {
    const graph = makeGraph(
      ["src/lib/util.test.ts", "src/lib/util.ts"],
      [["src/lib/util.test.ts", "src/lib/util.ts"]],
    );
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/util.test.ts", changeType: "modified" }], {}, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path), ["src/lib/util.test.ts"]);
    assert.ok(result.affectedTests[0]!.reasons.includes("DIRECT_TEST_CHANGE"));
    assert.ok(result.evidence.some((e) => e.reason === "DIRECT_TEST_CHANGE"));
  });

  it("selects an added test file itself (never silently skips a just-added test)", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/new.test.ts", changeType: "added" }], {}, { added: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path), ["src/lib/new.test.ts"]);
  });

  it("selects the rename destination and records only the legacy identity for the source", () => {
    const graph = makeGraph(["src/lib/renamed.test.ts"], []);
    const profile = makeProfile();
    const delta = makeDelta(
      "base",
      "head",
      [{ path: "src/lib/renamed.test.ts", oldPath: "src/lib/old.test.ts", changeType: "renamed" }],
      {},
      { renamed: 1 },
    );
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path), ["src/lib/renamed.test.ts"]);
    assert.ok(!result.affectedTests.some((t) => t.path === "src/lib/old.test.ts"));
    assert.ok(result.evidence.some((e) => e.reason === "RENAMED_FILE_LEGACY_IDENTITY"));
  });

  it("never selects a deleted test and requires full validation when its node is absent", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/deleted.test.ts", changeType: "deleted" }], {}, { deleted: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "DELETED_FILE_UNKNOWABLE_GRAPH"));
    assert.deepStrictEqual(result.affectedTests, []);
  });

  it("does not select a deleted test even when its stale node remains (legacy traversal only)", () => {
    const graph = makeGraph(["src/lib/deleted.test.ts"], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/deleted.test.ts", changeType: "deleted" }], {}, { deleted: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.ok(!result.affectedTests.some((t) => t.path === "src/lib/deleted.test.ts"));
  });
});

describe("directlyChangedExecutableTests", () => {
  const isTest = (p: string) => /\.(test|spec)\./.test(p);

  it("collects added/modified/renamed-dest/copied-dest tests and excludes deleted tests and source identities", () => {
    const delta = makeDelta(
      "base",
      "head",
      [
        { path: "src/a.test.ts", changeType: "added" },
        { path: "src/b.test.ts", changeType: "modified" },
        { path: "src/c.test.ts", oldPath: "src/c-old.test.ts", changeType: "renamed" },
        { path: "src/d.test.ts", oldPath: "src/d-old.test.ts", changeType: "copied" },
        { path: "src/e.test.ts", changeType: "deleted" },
        { path: "src/notest.ts", changeType: "modified" },
      ],
      {},
      {},
    );
    assert.deepStrictEqual(directlyChangedExecutableTests(delta, isTest), [
      "src/a.test.ts",
      "src/b.test.ts",
      "src/c.test.ts",
      "src/d.test.ts",
    ]);
  });
});

describe("empty test universe fails closed (Phase 01, 2026-08-26)", () => {
  // Measured on immerjs/immer: its entire `__tests__/` suite was invisible to discovery, so the
  // analyzer saw a repository with zero tests, found nothing to select, and reported
  // SAFE_TO_PROPOSE at COMPLETE confidence for 5 of 5 commits. An empty selection reads downstream
  // as "nothing needs to run", which makes the engine most confident exactly where it is blindest.
  const graph = makeGraph(["src/lib/util.ts", "src/app/main.ts"], [["src/app/main.ts", "src/lib/util.ts"]]);
  const delta = makeDelta("a", "b", [{ path: "src/lib/util.ts", changeType: "modified", isBinary: false }], {});

  it("falls back when a framework is declared and no test file was discovered", () => {
    const profile = makeProfile();
    profile.testUniverse = {
      declaredFrameworks: ["vitest"],
      frameworkEvidence: { vitest: "dependency:vitest" },
      discoveredTestFiles: 0,
      blindSpot: true,
    };
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);

    assert.equal(result.fallbackRequired, true);
    assert.equal(result.analysisStatus, "FALLBACK");
    assert.ok(result.fallbackReasons.some((r) => r.includes("no test files were discovered")));
    assert.ok(result.riskSignals.some((s) => s.reason === "TEST_UNIVERSE_EMPTY" && s.level === "critical"));
  });

  it("does not fall back when the repository's tests were found", () => {
    const profile = makeProfile();
    profile.testUniverse = {
      declaredFrameworks: ["vitest"],
      frameworkEvidence: { vitest: "dependency:vitest" },
      discoveredTestFiles: 12,
      blindSpot: false,
    };
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);

    assert.ok(!result.riskSignals.some((s) => s.reason === "TEST_UNIVERSE_EMPTY"));
  });

  it("treats an absent testUniverse as not-evaluated rather than as a blind spot", () => {
    // Fixture profiles predating Phase 01 must keep their existing verdicts.
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), makeProfile());
    assert.ok(!result.riskSignals.some((s) => s.reason === "TEST_UNIVERSE_EMPTY"));
  });
});
