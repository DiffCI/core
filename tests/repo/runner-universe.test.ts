// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Defect 17 regression suite — the modelled test universe must be what the RUNNER executes.
 *
 * The anchor case is real. On `kulshekhar/ts-jest` at `b1a97ac4`, DiffCI reported a universe of 40
 * where jest executes 20: `jest.config.ts` declares `testMatch: ['<rootDir>/src/**\/*.spec.ts']`, the
 * `<rootDir>/` token was never stripped so the declaration matched nothing, and the conventional
 * defaults were unioned on top so 20 `e2e/` and `examples/` spec files stayed in.
 *
 * Every selection fraction in the MECHANISM_PROOF_01 result was stated against a denominator roughly
 * twice the real one. The damage stopped at reporting only because none of the extra 20 was ever
 * selected — luck, not design.
 *
 * These tests pin BOTH directions:
 *   - an `e2e/`-style file outside the configured universe must not inflate the denominator OR the
 *     selection, and
 *   - a half-understood config must NOT narrow anything, because a test DiffCI cannot see is a test
 *     it cannot select, and that is the shape of a false green.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { analyzeRepository } from "../../src/repo/analyzer.js";
import { extractTestPatterns } from "../../src/repo/runner-universe.js";
import { discoverTestRunnerConfigs, testFileMatcherForProfile } from "../../src/repo/test-discovery.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "diffci-universe-"));
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** The ts-jest shape: a jest default config whose testMatch is scoped to src/, plus e2e/ and examples/. */
function tsJestShapedRepo(root: string): void {
  write(root, "package.json", `{"name":"ts-jest-shaped","scripts":{"test":"jest"},"devDependencies":{"jest":"^29.0.0"}}`);
  write(root, "jest.config.ts", `export default { testMatch: ['<rootDir>/src/**/*.spec.ts'] }`);
  write(root, "src/index.ts", `export const compile = (s: string) => s;`);
  write(root, "src/index.spec.ts", `import { compile } from "./index";\ntest("compiles", () => { compile("x"); });`);
  write(root, "src/utils/importer.ts", `export const importer = 1;`);
  write(root, "src/utils/importer.spec.ts", `import { importer } from "./importer";\ntest("imports", () => { importer; });`);
  // Executed by NOTHING under this configuration. Jest is configured never to look here.
  write(root, "e2e/hoist-jest/__tests__/hoist.spec.ts", `test("e2e", () => {});`);
  write(root, "e2e/enum/__tests__/enum.spec.ts", `test("e2e", () => {});`);
  write(root, "examples/react-app/src/app.spec.ts", `test("example", () => {});`);
}

describe("defect 17 - the test universe is the runner's, not the tree's", () => {
  it("an e2e/ file outside the configured testMatch does not inflate the DENOMINATOR", () => {
    const root = tmpRepo();
    try {
      tsJestShapedRepo(root);
      const profile = analyzeRepository({ repoPath: root });
      const tests = profile.testFilePaths ?? [];

      // The whole point: 2, not 5. Before the fix this counted every .spec.ts in the tree.
      assert.deepEqual(
        [...tests].sort(),
        ["src/index.spec.ts", "src/utils/importer.spec.ts"],
        "only files jest's testMatch can execute belong in the universe",
      );
      for (const path of tests) {
        assert.ok(!path.startsWith("e2e/"), `e2e/ file ${path} is outside jest's testMatch`);
        assert.ok(!path.startsWith("examples/"), `examples/ file ${path} is outside jest's testMatch`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an e2e/ file outside the configured testMatch cannot appear in a SELECTION either", () => {
    // The denominator was the visible symptom. This is the one that could have cost recall: a
    // selection containing a file the runner never runs looks like coverage and detects nothing.
    const root = tmpRepo();
    try {
      tsJestShapedRepo(root);
      const profile = analyzeRepository({ repoPath: root });
      assert.ok(profile.testPatterns, "profile must carry the test universe");
      const isTest = testFileMatcherForProfile(profile);
      assert.equal(isTest("e2e/hoist-jest/__tests__/hoist.spec.ts"), false);
      assert.equal(isTest("examples/react-app/src/app.spec.ts"), false);
      assert.equal(isTest("src/index.spec.ts"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("<rootDir>/ is stripped, because a repo-relative path never contains it", () => {
    const x = extractTestPatterns(`export default { testMatch: ['<rootDir>/src/**/*.spec.ts'] }`);
    assert.deepEqual(x.includes, ["src/**/*.spec.ts"]);
    assert.equal(x.declaresTests, true);
    assert.equal(x.complete, true);
  });

  it("a <rootDir> that is NOT a leading token leaves the config not fully understood", () => {
    // Resolving it would mean evaluating the config, which this scanner never does. Unresolved means
    // wide, not narrow.
    const x = extractTestPatterns(`export default { testMatch: ['src/<rootDir>/**/*.spec.ts'] }`);
    assert.equal(x.complete, false);
  });
});

describe("defect 17 - narrowing requires COMPLETE understanding", () => {
  const incomplete: Array<[string, string]> = [
    ["a spread", `const extra = ['a/**/*.spec.ts']; export default { testMatch: ['src/**/*.spec.ts', ...extra] }`],
    ["an unresolved identifier", `export default { testMatch: GLOBS }`],
    ["an interpolated template", "export default { testMatch: [`${dir}/**/*.spec.ts`] }"],
    ["a call expression", `export default { testMatch: [resolve('src/**/*.spec.ts')] }`],
  ];

  for (const [label, source] of incomplete) {
    it(`${label} marks the declaration incomplete, so the wide universe survives`, () => {
      assert.equal(extractTestPatterns(source).complete, false, `${label} must not be treated as understood`);
    });
  }

  it("a half-understood config does NOT drop the conventional defaults", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", `{"name":"partial","scripts":{"test":"jest"}}`);
      write(root, "jest.config.js", `const extra = require('./globs'); module.exports = { testMatch: ['<rootDir>/src/**/*.spec.ts', ...extra] }`);
      const d = discoverTestRunnerConfigs(root, { test: "jest" });
      assert.equal(d.configs[0]!.authoritative, false);
      assert.equal(d.replacedDefaults, false, "an unread spread must leave the universe WIDE, never narrow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a NAMED variant config never speaks for what the bare runner executes", () => {
    // vitest.e2e.config.ts is a separate job. Letting it replace the defaults would delete every
    // *.spec.ts from a repository whose only config file happens to be an e2e one.
    const root = tmpRepo();
    try {
      write(root, "package.json", `{"name":"variant-only","scripts":{"test":"vitest run"}}`);
      write(root, "vitest.e2e.config.ts", `export default { test: { include: ['e2e/**/*.e2e.ts'] } }`);
      const d = discoverTestRunnerConfigs(root, { test: "vitest run" });
      assert.equal(d.configs[0]!.authoritative, true, "the variant itself was understood");
      assert.equal(d.replacedDefaults, false, "but it says nothing about plain `vitest`");
      assert.ok(d.patterns.some((p) => p.includes("*.spec.")), "conventional defaults must survive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a repository with no runner config is completely unaffected", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", `{"name":"plain","scripts":{"test":"node --test"}}`);
      const d = discoverTestRunnerConfigs(root, { test: "node --test" });
      assert.deepEqual(d.configs, []);
      assert.equal(d.replacedDefaults, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("defect 17 - testPathIgnorePatterns and roots", () => {
  it("testPathIgnorePatterns is honoured as a REGEX, not a glob", () => {
    const x = extractTestPatterns(`export default { testMatch: ['<rootDir>/src/**/*.spec.ts'], testPathIgnorePatterns: ['/fixtures/'] }`);
    assert.deepEqual(x.ignoreRegexSources, ["/fixtures/"]);
  });

  it("an ignored path leaves the universe even when the include glob matches it", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", `{"name":"ignores","scripts":{"test":"jest"},"devDependencies":{"jest":"^29.0.0"}}`);
      write(root, "jest.config.ts", `export default { testMatch: ['<rootDir>/src/**/*.spec.ts'], testPathIgnorePatterns: ['/__fixtures__/'] }`);
      write(root, "src/real.spec.ts", `test("real", () => {});`);
      write(root, "src/__fixtures__/ignored.spec.ts", `test("ignored", () => {});`);
      const profile = analyzeRepository({ repoPath: root });
      assert.deepEqual([...(profile.testFilePaths ?? [])].sort(), ["src/real.spec.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("roots confine the universe", () => {
    const x = extractTestPatterns(`export default { roots: ['<rootDir>/src'], testMatch: ['<rootDir>/**/*.spec.ts'] }`);
    assert.deepEqual(x.roots, ["src"]);
  });
});
