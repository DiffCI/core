// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runPathBaseline } from "../../src/planner/path-baseline.js";
import type { ChangedFile } from "../../src/git/types.js";
import type { RepositoryProfile, SourceRoot } from "../../src/repo/types.js";

describe("runPathBaseline", () => {
  const ALL = ["src/a.test.ts", "src/b.test.ts", "scripts/do.test.ts", "ops/infra.test.ts"];

  function changed(...paths: string[]): ChangedFile[] {
    return paths.map((p) => ({ path: p, changeType: "modified" }));
  }

  it("selects no tests for docs-only changes", () => {
    const result = runPathBaseline(ALL, changed("README.md", "docs/guide.md"));
    assert.deepEqual(result.selectedTests, []);
    assert.ok(!result.fallbackRequired);
    assert.deepEqual(result.matchedRules, ["docs-only -> skip tests"]);
  });

  it("falls back to all tests on config/dependency changes", () => {
    const result = runPathBaseline(ALL, changed("package.json", "package-lock.json"));
    assert.deepEqual(result.selectedTests, ALL);
    assert.ok(result.fallbackRequired);
  });

  it("falls back on workflow changes", () => {
    const result = runPathBaseline(ALL, changed(".github/workflows/ci.yml"));
    assert.deepEqual(result.selectedTests, ALL);
    assert.ok(result.fallbackRequired);
  });

  it("falls back on database or infrastructure changes", () => {
    const db = runPathBaseline(ALL, changed("database/migrations/001.sql"));
    const infra = runPathBaseline(ALL, changed("docker/Dockerfile", "ops/aws/main.tf"));
    assert.ok(db.fallbackRequired);
    assert.ok(infra.fallbackRequired);
    assert.deepEqual(db.selectedTests, ALL);
  });

  it("scopes a change to the tests beside it", () => {
    // Same selection as the old `src/** -> all source tests` rule, reached without naming `src`:
    // src/pages/ holds no tests, src/ does, so src/ is the scope.
    const result = runPathBaseline(ALL, changed("src/pages/index.tsx"));
    assert.deepEqual(result.selectedTests, ["src/a.test.ts", "src/b.test.ts"]);
    assert.ok(!result.fallbackRequired);
    assert.ok(result.matchedRules.some((r) => r.startsWith("directory scoping -> tests under src")));
  });

  it("falls back when no directory scoping applies", () => {
    const result = runPathBaseline(ALL, changed("config/nested.conf", "random.txt"));
    assert.deepEqual(result.selectedTests, ALL);
    assert.ok(result.fallbackRequired);
    assert.ok(result.matchedRules.includes("no directory scoping applies -> run all tests"));
  });

  it("runs everything when even one changed file cannot be scoped", () => {
    // A path-rule CI that cannot place one file has to run everything; scoping the rest and ignoring
    // the outlier would flatter the baseline, and the baseline is what savings are measured against.
    const result = runPathBaseline(ALL, changed("src/pages/index.tsx", "random.txt"));
    assert.deepEqual(result.selectedTests, ALL);
    assert.ok(result.fallbackRequired);
  });
});

describe("runPathBaseline scoping patterns (Phase 01 follow-up, 2026-08-26)", () => {
  function changed(...paths: string[]): ChangedFile[] {
    return paths.map((p) => ({ path: p, changeType: "modified" }));
  }

  function profileWithRoots(roots: Array<{ path: string; kind: SourceRoot["kind"] }>): RepositoryProfile {
    return {
      packageManager: "npm",
      packageJson: { name: "fixture", scripts: {}, dependencies: [], devDependencies: [] },
      sourceRoots: roots,
      tests: [],
      testFilePaths: [],
      workflows: [],
      configFiles: [],
      pathAliases: [],
      entryPoints: [],
      stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 },
    };
  }

  it("scopes a monorepo change to its own package (nestjs/nest's shape)", () => {
    // Measured before this rewrite: nest scoped 0 of 5 commits, because nothing matched `src/**`,
    // `scripts/**` or `ops/**`. A path-rule CI would obviously run packages/core's tests here.
    const tests = [
      "packages/core/test/injector.spec.ts",
      "packages/core/test/scanner.spec.ts",
      "packages/common/test/utils.spec.ts",
    ];
    const result = runPathBaseline(tests, changed("packages/core/injector/injector.ts"));

    assert.deepEqual(result.selectedTests, ["packages/core/test/injector.spec.ts", "packages/core/test/scanner.spec.ts"]);
    assert.ok(!result.fallbackRequired, "a monorepo change must not force the whole suite");
  });

  it("scopes a mirrored src/tests layout to the mirrored directory (this repository's shape)", () => {
    // The colocated rule cannot see this layout: no ancestor of src/repo/impact.ts contains a test.
    const tests = ["tests/repo/impact.test.ts", "tests/repo/graph.test.ts", "tests/planner/planner.test.ts"];
    const profile = profileWithRoots([
      { path: "src", kind: "source" },
      { path: "tests", kind: "tests" },
    ]);
    const result = runPathBaseline(tests, changed("src/repo/impact.ts"), profile);

    assert.deepEqual(result.selectedTests, ["tests/repo/graph.test.ts", "tests/repo/impact.test.ts"]);
    assert.ok(!result.fallbackRequired);
  });

  it("walks the mirrored directory up until one that holds tests", () => {
    const tests = ["tests/repo/impact.test.ts"];
    const profile = profileWithRoots([
      { path: "src", kind: "source" },
      { path: "tests", kind: "tests" },
    ]);
    const result = runPathBaseline(tests, changed("src/repo/deeply/nested/thing.ts"), profile);

    assert.deepEqual(result.selectedTests, ["tests/repo/impact.test.ts"]);
  });

  it("still runs everything when a mirrored root exists but the change is outside every source root", () => {
    const tests = ["tests/repo/impact.test.ts"];
    const profile = profileWithRoots([
      { path: "src", kind: "source" },
      { path: "tests", kind: "tests" },
    ]);
    const result = runPathBaseline(tests, changed("vendor/thing.ts"), profile);

    assert.deepEqual(result.selectedTests, tests);
    assert.ok(result.fallbackRequired);
  });
});
