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
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import type { GitDelta } from "../../src/git/types.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "diffci-universe-"));
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function sourceDelta(path = "src/value.js"): GitDelta {
  return {
    baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  };
}

async function sourcePlan(root: string) {
  const graph = await buildDependencyGraph({ repoPath: root });
  const delta = sourceDelta();
  const impact = new ImpactAnalyzer().analyze(delta, graph, graph.profile);
  const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta, impact, profile: graph.profile });
  return { graph, impact, plan };
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

describe("complete runner declarations preserve every executable suite", () => {
  it("retains a literal test filename alongside wildcard includes", async () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
      write(root, "vitest.config.ts", "export default { test: { include: ['src/**/*.test.js', 'regression.test.js'] } };");
      write(root, "src/value.js", "export const value = 1;");
      write(root, "src/other.test.js", "import { test } from 'vitest'; test('unrelated', () => {});");
      write(root, "regression.test.js", "import { test, expect } from 'vitest'; import { value } from './src/value.js'; test('regression', () => expect(value).toBe(1));");

      const { graph, plan } = await sourcePlan(root);
      assert.ok(graph.profile.testFilePaths.includes("regression.test.js"));
      assert.equal(plan.mode, "SELECTIVE");
      assert.deepEqual(plan.selectedTests, ["regression.test.js"]);
      assert.ok(plan.commandSpecs.some(command => command.args.includes("regression.test.js")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("routes literal excludes to the other suite without excluding same-named nested tests", async () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
      write(root, "vitest.config.ts", "export default { test: { include: ['**/*.test.js'], exclude: ['regression.test.js'] } };");
      write(root, "src/value.js", "export const value = 1;");
      write(root, "src/other.test.js", "export const unrelated = true;");
      write(root, "regression.test.js", "import { value } from './src/value.js'; export const checked = value;");
      write(root, "src/regression.test.js", "import { value } from './value.js'; export const checked = value;");
      const single = await sourcePlan(root);
      assert.deepEqual(single.plan.selectedTests, ["src/regression.test.js"]);
      assert.ok(!single.graph.profile.testFilePaths.includes("regression.test.js"));

      write(root, "vitest.integration.config.ts", "export default { test: { include: ['regression.test.js'] } };");
      const multiple = await sourcePlan(root);
      assert.deepEqual(multiple.plan.selectedTests, ["regression.test.js", "src/regression.test.js"]);
      assert.ok(multiple.plan.commandSpecs.some(command => command.args.includes("vitest.integration.config.ts") && command.args.includes("regression.test.js")));
      assert.ok(multiple.plan.commandSpecs.every(command => !command.args.includes("vitest.config.ts") || !command.args.includes("regression.test.js")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const restriction of [
    "exclude: ['test/integration/**']",
    "roots: ['test/unit']",
    "testPathIgnorePatterns: ['/integration/']",
  ]) {
    it(`does not apply one config's ${restriction.split(':')[0]} to a separate suite`, async () => {
      const root = tmpRepo();
      const runner = restriction.startsWith("exclude") ? "vitest" : "jest";
      const include = runner === "vitest" ? "include" : "testMatch";
      const config = (body: string) => runner === "vitest" ? `export default { test: { ${body} } };` : `export default { ${body} };`;
      try {
        write(root, "package.json", JSON.stringify({ type: "module", scripts: { test: `${runner} run`, "test:integration": `${runner} run --config ${runner}.integration.config.ts` }, devDependencies: { [runner]: "1" } }));
        write(root, `${runner}.config.ts`, config(`${include}: ['**/*.test.js'], ${restriction}`));
        write(root, `${runner}.integration.config.ts`, config(`${include}: ['test/integration/**/*.test.js']`));
        write(root, "src/value.js", "export const value = 1;");
        write(root, "test/unit/other.test.js", "export const unrelated = true;");
        write(root, "test/integration/affected.test.js", "import { value } from '../../src/value.js'; export const checked = value;");

        const { graph, plan } = await sourcePlan(root);
        assert.ok(graph.profile.testFilePaths.includes("test/integration/affected.test.js"));
        assert.equal(plan.mode, "SELECTIVE");
        assert.deepEqual(plan.selectedTests, ["test/integration/affected.test.js"]);
        assert.equal(plan.commandSynthesis?.status, "OK");
        assert.equal(plan.commandSpecs.length, 1);
        assert.ok(plan.commandSpecs[0]!.args.includes(`${runner}.integration.config.ts`));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const [runner, rootSetting] of [["jest", "rootDir: 'app'"], ["vitest", "root: 'app'"], ["jest", "rootDir: process.env.TEST_ROOT"], ["jest", "['rootDir']: 'app'"]] as const) {
    it(`falls back when ${runner} has an unsupported ${rootSetting}`, async () => {
      const root = tmpRepo();
      try {
        write(root, "package.json", JSON.stringify({ type: "module", devDependencies: { [runner]: "1" } }));
        write(root, `${runner}.config.ts`, runner === "jest"
          ? `export default { ${rootSetting}, testMatch: ['<rootDir>/tests/**/*.test.js'] };`
          : `export default { ${rootSetting}, test: { include: ['tests/**/*.test.js'] } };`);
        write(root, "src/value.js", "export const value = 1;");
        write(root, "tests/other.test.js", "export const unrelated = true;");
        write(root, "app/tests/affected.test.js", "import { value } from '../../src/value.js'; export const checked = value;");

        const { graph, plan } = await sourcePlan(root);
        assert.ok(graph.profile.testFilePaths.length > 0, "a nonempty partial universe must not bypass fallback");
        assert.equal(plan.mode, "FULL");
        assert.ok(plan.fallbackReasons.some(reason => /rootDir|root/.test(reason)));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const mutation of ["config.rootDir = 'app'", "config['rootDir'] = 'app'"]) {
    it(`falls back for a mutated runner root: ${mutation}`, async () => {
      const root = tmpRepo();
      try {
        write(root, "package.json", JSON.stringify({ type: "module", devDependencies: { jest: "1" } }));
        write(root, "jest.config.ts", `const config = { testMatch: ['<rootDir>/tests/**/*.test.js'] }; ${mutation}; export default config;`);
        write(root, "src/value.js", "export const value = 1;");
        write(root, "tests/other.test.js", "export const unrelated = true;");
        write(root, "app/tests/affected.test.js", "import { value } from '../../src/value.js'; export const checked = value;");
        const { plan } = await sourcePlan(root);
        assert.equal(plan.mode, "FULL");
        assert.ok(plan.fallbackReasons.some(reason => reason.includes("rootDir")));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const implicitDefault of [true, false]) {
    it(`falls back when the ${implicitDefault ? 'default' : 'named'} config has an implicit suite`, async () => {
      const root = tmpRepo();
      try {
        write(root, "package.json", JSON.stringify({ type: "module", devDependencies: { vitest: "1" } }));
        write(root, "vitest.config.ts", implicitDefault ? "export default {};" : "export default { test: { include: ['src/**/*.test.js'] } };");
        write(root, "vitest.browser.config.ts", implicitDefault ? "export default { test: { include: ['test/**/*.test.js'] } };" : "export default {};");
        write(root, "src/value.js", "export const value = 1;");
        write(root, "src/other.test.js", "export const unrelated = true;");
        write(root, "test/affected.test.js", "import { value } from '../src/value.js'; export const checked = value;");
        const { plan } = await sourcePlan(root);
        assert.equal(plan.mode, "FULL");
        assert.ok(plan.fallbackReasons.some(reason => reason.includes("explicit test includes")));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it("keeps explicitly declared repository roots supported", () => {
    const root = tmpRepo();
    try {
      write(root, "jest.config.ts", "export default { rootDir: '.', testMatch: ['<rootDir>/src/**/*.test.js'] };");
      write(root, "vitest.config.ts", "export default { root: './', test: { include: ['src/**/*.test.js'] } };");
      const discovery = discoverTestRunnerConfigs(root);
      assert.ok(discovery.configs.every(config => config.authoritative && !config.discoveryError));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
