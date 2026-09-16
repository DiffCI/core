// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";

// Regression coverage for the discoverTests() bug found during the Stage 0 real pilot
// (2026-08-19, pmndrs/zustand + honojs/hono): its ad-hoc prefix-extraction matching logic
// never matched the actual DEFAULT_TEST_PATTERNS shape ("**/*.test.{ts,tsx,...}"), so
// profile.tests always came back empty. The follow-up fix (globToRegex/matchesTestGlob)
// itself initially inherited a second bug shared with src/planner/planner.ts and
// src/research/baseline/matcher.ts: the "**/" -> "(?:.*/)?" substitution got corrupted by
// the subsequent global "*" -> "[^/]*" replace, so only files zero or one directory level
// deep matched reliably. Both are covered here.

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-analyzer-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  return dir;
}

describe("analyzeRepository discoverTests", () => {
  it("finds test files matching the default **/*.test.{ext} pattern, including nested ones", () => {
    const dir = createTempRepo();
    try {
      mkdirSync(join(dir, "src/lib/security"), { recursive: true });
      writeFileSync(join(dir, "src/top.test.ts"), "test('a', () => {});\n");
      writeFileSync(join(dir, "src/lib/mid.test.ts"), "test('b', () => {});\n");
      writeFileSync(join(dir, "src/lib/security/deep.test.ts"), "test('c', () => {});\n");
      writeFileSync(join(dir, "src/lib/security/not-a-test.ts"), "export const x = 1;\n");

      const profile = analyzeRepository({ repoPath: dir });

      assert.equal(profile.tests.length, 1);
      assert.equal(profile.tests[0]?.glob, "**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}");
      assert.equal(profile.tests[0]?.count, 3, "should count the top-level, one-deep, and two-deep test files");
      assert.equal(profile.stats.testFiles, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a real-world-shaped nested test tree completely (regression for the globstar matcher)", () => {
    const dir = createTempRepo();
    try {
      const paths = [
        "src/router/common.case.test.ts",
        "src/middleware/csrf/index.test.ts",
        "src/middleware/pretty-json/index.test.ts",
        "src/utils/ipaddr.test.ts",
        "src/jsx/dom/index.test.tsx",
      ];
      for (const p of paths) {
        mkdirSync(join(dir, p, ".."), { recursive: true });
        writeFileSync(join(dir, p), "test('x', () => {});\n");
      }

      const profile = analyzeRepository({ repoPath: dir });
      const totalCount = profile.tests.reduce((sum, t) => sum + t.count, 0);
      assert.equal(totalCount, paths.length, "every nested test file should be discovered regardless of depth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds tests in a monorepo (packages/<name>/src/) even when an unrelated auxiliary top-level dir exists", () => {
    // Real finding, Stage 0 medium batch (2026-08-21): colinhacks/zod, sindresorhus/execa, trpc/trpc,
    // and sindresorhus/ky all have a top-level scripts/ directory (build/release tooling - an
    // AUXILIARY root, not application code) but no src/app/lib/tests/test/api at the root; their real
    // source and tests live nested under packages/<name>/src/. The old discoverSourceRoots() fallback
    // only scanned every top-level directory when ZERO conventional roots were found at all - scripts/
    // alone being present was enough to suppress it, so packages/ (where everything actually is) was
    // never scanned. testsTotal came back 0 for every single delta in these repositories - not a
    // near-miss, a complete miss - while testsSelectedByDiffci (computed independently via the
    // TypeScript compiler's own tsconfig `include` globs, not this directory-walk heuristic) stayed
    // correct, producing "selected > total" impossible records once aggregated.
    const dir = createTempRepo();
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts/release.js"), "// build tooling, not application code\n");
      mkdirSync(join(dir, "packages/core/src/tests"), { recursive: true });
      writeFileSync(join(dir, "packages/core/src/index.ts"), "export const x = 1;\n");
      writeFileSync(join(dir, "packages/core/src/tests/index.test.ts"), "test('x', () => {});\n");

      const profile = analyzeRepository({ repoPath: dir });

      assert.ok(profile.testFilePaths.length > 0, "must not silently miss the monorepo's real tests just because scripts/ exists");
      assert.ok(profile.testFilePaths.some((p) => p.includes("packages/core/src/tests/index.test.ts")));
      assert.equal(profile.stats.testFiles, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers tests anywhere in the tree, and still never descends into excluded directories", () => {
    // Phase 01 (2026-08-26). This test previously asserted the opposite - that discovery stays inside
    // the source roots, so a test file under docs/ was deliberately NOT found. That was DiffCI
    // imposing its own layout: a repository whose runner include glob is `**\/*.test.ts` really would
    // run that file, and the same heuristic hid 239 of facebook/docusaurus's 241 tests under
    // packages/. Where a repository keeps its tests is the one thing that must not be guessed.
    //
    // What genuinely must not be scanned is build output and dependencies, and that is still enforced
    // by the exclusion set rather than by the source-root list.
    const dir = createTempRepo();
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.test.ts"), "test('a', () => {});\n");
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/unrelated.test.ts"), "test('found now', () => {});\n");
      mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
      writeFileSync(join(dir, "node_modules/pkg/vendored.test.ts"), "test('never', () => {});\n");
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist/built.test.ts"), "test('never', () => {});\n");

      const profile = analyzeRepository({ repoPath: dir });

      assert.deepEqual(profile.testFilePaths, ["docs/unrelated.test.ts", "src/a.test.ts"]);
      assert.ok(!profile.testFilePaths.some((p) => p.startsWith("node_modules/")), "dependencies are never tests");
      assert.ok(!profile.testFilePaths.some((p) => p.startsWith("dist/")), "build output is never a test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
