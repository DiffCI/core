// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createTestFileMatcher, DEFAULT_TEST_PATTERNS, discoverTestRunnerConfigs, extractIncludeGlobs, matchesGlob, testFamilyOfPath } from "../../src/repo/test-discovery.js";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";

function tmpRepo(): string { return mkdtempSync(join(tmpdir(), "diffci-test-discovery-")); }
function write(root: string, rel: string, content: string): void { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), content); }

describe("extractIncludeGlobs (static, never executes the config)", () => {
  it("lifts literals from inline arrays, identifier indirection, spreads and conditionals", () => {
    const src = `
      import { defineConfig } from 'vitest/config' // comment with 'quote'
      const testIncludes = [
        'packages/*/*/tests/**/*.spec.{ts,tsx}',
        'scripts/**/*.spec.ts',
      ]
      /* block 'comment' */
      export default defineConfig({ test: { include: testIncludes, exclude: ['**/node_modules/**'] } })
      const other = defineConfig({ test: { include: [
        'scripts/**/*.snapshot.ts',
        ...(process.env.MODE === 'lib' ? ['apps/web/tests/**/*.snapshot.ts'] : []),
        'examples/*/tests/**/*.snapshot.ts',
      ] } })`;
    assert.deepStrictEqual(extractIncludeGlobs(src), [
      "packages/*/*/tests/**/*.spec.{ts,tsx}",
      "scripts/**/*.spec.ts",
      "scripts/**/*.snapshot.ts",
      "apps/web/tests/**/*.snapshot.ts",
      "examples/*/tests/**/*.snapshot.ts",
    ]);
  });
  it("never lifts a coverage include (instrumented sources are not tests)", () => {
    const src = `export default { test: { include: ["tests/**/*.spec.ts"], coverage: { include: ["packages/*/*/src/**/*.{ts,tsx}"], exclude: ["**/x"] , thresholds: { lines: 100 } }, projects: [{ test: { include: ["scripts/**/*.spec.ts"] } }] } }`;
    assert.deepStrictEqual(extractIncludeGlobs(src), ["tests/**/*.spec.ts", "scripts/**/*.spec.ts"]);
  });
  it("ignores exclude lists, negations and non-glob strings; reads Jest testMatch", () => {
    assert.deepStrictEqual(extractIncludeGlobs(`module.exports = { testMatch: ['<rootDir>/src/**/*.it.ts', '!**/skip/**'], exclude: ['x/**'] }`), ["<rootDir>/src/**/*.it.ts"]);
    assert.deepStrictEqual(extractIncludeGlobs(`export default { test: { include: ['MODE', 'plain'] } }`), []);
    assert.deepStrictEqual(extractIncludeGlobs(`export default {}`), []);
  });
});

describe("testFamilyOfPath", () => {
  it("derives the family from the filename token only", () => {
    assert.strictEqual(testFamilyOfPath("packages/a/tests/x.spec.ts"), "unit");
    assert.strictEqual(testFamilyOfPath("src/x.test.tsx"), "unit");
    assert.strictEqual(testFamilyOfPath("examples/acp-agent/tests/acp.snapshot.ts"), "snapshot");
    assert.strictEqual(testFamilyOfPath("apps/cli/tests/cli.e2e.ts"), "e2e");
    assert.strictEqual(testFamilyOfPath("src/db.integration.ts"), "integration");
    assert.strictEqual(testFamilyOfPath("src/index.ts"), undefined);
    assert.strictEqual(testFamilyOfPath("src/foo.config.ts"), undefined);
  });
});

describe("createTestFileMatcher", () => {
  it("matches defaults exactly like the old regex for conventional names and nothing else", () => {
    const m = createTestFileMatcher(DEFAULT_TEST_PATTERNS);
    for (const p of ["a.test.ts", "deep/x/y.spec.tsx", "src/z.test.mjs"]) assert.ok(m(p), p);
    for (const p of ["a.snapshot.ts", "b.e2e.ts", "tests/helper.ts", "a.test.txt"]) assert.strictEqual(m(p), false, p);
  });
  it("honours config globs, anchoring bare filename globs anywhere", () => {
    const m = createTestFileMatcher(["examples/*/tests/**/*.snapshot.ts", "*.e2e.ts"]);
    assert.ok(m("examples/acp-agent/tests/acp.snapshot.ts"));
    assert.strictEqual(m("packages/x/tests/acp.snapshot.ts"), false, "snapshot glob is scoped to examples/*");
    assert.ok(m("anywhere/deep/run.e2e.ts"));
  });
});

describe("discoverTestRunnerConfigs on a real directory", () => {
  it("finds root vitest configs, lifts includes, maps invoking scripts and families; default config has no family", () => {
    const root = tmpRepo();
    try {
      write(root, "vitest.config.ts", `const inc = ['packages/*/tests/**/*.spec.ts']\nexport default { test: { include: inc } }`);
      write(root, "vitest.e2e.config.ts", `export default { test: { include: ['packages/*/tests/**/*.e2e.ts'] } }`);
      write(root, "vitest.snapshot.config.ts", `export default { test: { include: ['examples/*/tests/**/*.snapshot.ts'] } }`);
      write(root, "vitest.web.config.ts", `export default { test: { include: ['apps/web/tests/**/*.e2e.ts', 'apps/web/tests/**/*.snapshot.ts'] } }`);
      write(root, "jest.config.js", `module.exports = { testMatch: ['<rootDir>/legacy/**/*.it.js'] }`);
      write(root, "vitest.config.ts.bak", `include: ['should/not/be/read/**']`);
      const scripts = { test: "vitest run", "test:e2e": "vitest run --config vitest.e2e.config.ts", "test:snapshot": "DSH=1 vitest run --config vitest.snapshot.config.ts", "test:web": "vitest run --config=vitest.web.config.ts", lint: "eslint ." };
      const d = discoverTestRunnerConfigs(root, scripts);
      assert.deepStrictEqual(d.configs.map((c) => c.file), ["jest.config.js", "vitest.config.ts", "vitest.e2e.config.ts", "vitest.snapshot.config.ts", "vitest.web.config.ts"]);
      const byFile = Object.fromEntries(d.configs.map((c) => [c.file, c]));
      assert.deepStrictEqual(byFile["vitest.config.ts"]!.includes, ["packages/*/tests/**/*.spec.ts"]);
      assert.deepStrictEqual(byFile["vitest.config.ts"]!.scripts, ["test"]);
      assert.strictEqual(byFile["vitest.config.ts"]!.family, undefined);
      assert.strictEqual(byFile["vitest.e2e.config.ts"]!.family, "e2e");
      assert.deepStrictEqual(byFile["vitest.e2e.config.ts"]!.scripts, ["test:e2e"]);
      assert.strictEqual(byFile["vitest.snapshot.config.ts"]!.family, "snapshot");
      assert.deepStrictEqual(byFile["vitest.snapshot.config.ts"]!.scripts, ["test:snapshot"]);
      assert.strictEqual(byFile["vitest.web.config.ts"]!.family, undefined, "family of 'web' comes from each file's token");
      assert.deepStrictEqual(byFile["vitest.web.config.ts"]!.scripts, ["test:web"]);
      // <rootDir> is jest own repo-root token. Lifting it VERBATIM - which this assertion used to
      // require - produced a glob that matches no repo-relative path at all, so the declaration was
      // silently inert and the conventional defaults decided the universe on their own. That is one
      // half of defect 17; the corrected behaviour strips the token.
      assert.deepStrictEqual(byFile["jest.config.js"]!.includes, ["legacy/**/*.it.js"]);
      assert.ok(!d.patterns.some((p) => p.includes("should/not/be/read")));
      assert.ok(d.patterns.includes("examples/*/tests/**/*.snapshot.ts"));
      // Both DEFAULT configs here (vitest.config.ts, jest.config.js) declare their own globs and are
      // fully understood, so between them they state exactly what the two runners execute. The
      // conventional .test./.spec. defaults are therefore DROPPED - keeping them would re-add files
      // neither runner is configured to run, which is the other half of defect 17.
      assert.strictEqual(d.replacedDefaults, true);
      for (const p of DEFAULT_TEST_PATTERNS) assert.ok(!d.patterns.includes(p), `default ${p} must not survive an authoritative declaration`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a repository without runner configs keeps exactly the default patterns (existing repos unaffected)", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", `{"name":"plain"}`);
      const d = discoverTestRunnerConfigs(root, { test: "node --test" });
      assert.deepStrictEqual(d.configs, []);
      assert.deepStrictEqual(d.patterns, [...DEFAULT_TEST_PATTERNS]);
      assert.deepStrictEqual(discoverTestRunnerConfigs(join(root, "missing")).patterns, [...DEFAULT_TEST_PATTERNS]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("analyzer + graph use the discovered universe", () => {
  it("profile.testFilePaths and graph isTest include snapshot/e2e files only when a config declares them", async () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "disc", version: "1.0.0", type: "module", scripts: { test: "vitest run", "test:snapshot": "vitest run --config vitest.snapshot.config.ts" } }));
      write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["**/*.ts"] }));
      write(root, "src/lib.ts", "export const x = 1;\n");
      write(root, "tests/lib.spec.ts", "import { x } from '../src/lib.js'; if (x !== 1) throw new Error();\n");
      write(root, "tests/lib.snapshot.ts", "import { x } from '../src/lib.js'; export const s = x;\n");
      write(root, "tests/lib.e2e.ts", "import { x } from '../src/lib.js'; export const e = x;\n");

      const before = analyzeRepository({ repoPath: root });
      assert.deepStrictEqual(before.testFilePaths, ["tests/lib.spec.ts"], "no config -> only conventional names");
      // Phase 01 (2026-08-26): a repository that declares vitest also contributes vitest's OWN default
      // include glob, so a repository relying on its runner's defaults is no longer invisible. That
      // glob is equivalent to the two conventional patterns here, which is why the discovered file
      // list above is unchanged - the addition widens coverage without moving this case.
      for (const pattern of DEFAULT_TEST_PATTERNS) {
        assert.ok(before.testPatterns?.includes(pattern), `expected default pattern ${pattern}`);
      }
      assert.ok(
        before.testPatterns?.includes("**/*.{test,spec}.?(c|m)[jt]s?(x)"),
        "vitest is declared via the test script, so vitest's default include belongs in the universe",
      );

      write(root, "vitest.snapshot.config.ts", `export default { test: { include: ['tests/**/*.snapshot.ts'] } }`);
      const after = analyzeRepository({ repoPath: root });
      assert.deepStrictEqual(after.testFilePaths, ["tests/lib.snapshot.ts", "tests/lib.spec.ts"], "snapshot declared, e2e still not");
      assert.strictEqual(after.testRunnerConfigs?.length, 1);
      assert.deepStrictEqual(after.testRunnerConfigs?.[0]?.scripts, ["test:snapshot"]);

      const graph = await buildDependencyGraph({ repoPath: root });
      const isTest = Object.fromEntries(graph.graph.nodes.map((n) => [n.path, n.isTest]));
      assert.strictEqual(isTest["tests/lib.spec.ts"], true);
      assert.strictEqual(isTest["tests/lib.snapshot.ts"], true);
      assert.strictEqual(isTest["tests/lib.e2e.ts"], false);
      assert.strictEqual(graph.profile.stats.testFiles, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/**
 * The glob matcher's semantic contract, and a bounded-runtime guarantee.
 *
 * Both exist because of one function deleted from impact.ts on 2026-08-30, which hand-translated glob
 * syntax into regex by string substitution and carried two defects at once: it produced
 * `^.([^/]*.)+(spec|test).[jt]s.(x)$`, a nested quantifier that backtracks catastrophically (30 seconds
 * for ONE non-matching 28-character path, roughly 4x per additional character), and it stripped the
 * leading `**\/` before anchoring, so `**\/__tests__\/**\/*` matched no nested path at all.
 *
 * The contract below is semantic rather than implementation-specific on purpose: it should hold for any
 * matcher, including a third-party one, if this is ever replaced again.
 */
describe("glob matching: semantic contract", () => {
  const matches = (path: string, glob: string): boolean => matchesGlob(path, glob);

  it("matches jest's default spec/test pattern at any depth", () => {
    const glob = "**/?(*.)+(spec|test).[jt]s?(x)";
    // `?(*.)` is "optionally: anything, then a dot" - a glob in its own right. Escaping its body as a
    // literal made `src/foo.test.js` match nothing while bare `test.js` still matched.
    for (const path of ["test.js", "src/foo.test.js", "src/foo.spec.ts", "a/b/c/deep.test.tsx", "x.spec.jsx"]) {
      assert.equal(matches(path, glob), true, `${path} should match ${glob}`);
    }
    for (const path of ["src/index.js", "src/testing/helper.js", "README.md", "src/spectrum.js"]) {
      assert.equal(matches(path, glob), false, `${path} should NOT match ${glob}`);
    }
  });

  it("matches a nested __tests__ directory, which the deleted matcher could not", () => {
    const glob = "**/__tests__/**/*.[jt]s?(x)";
    assert.equal(matches("src/__tests__/foo.test.js", glob), true);
    assert.equal(matches("__tests__/foo.js", glob), true);
    assert.equal(matches("packages/a/src/__tests__/deep/b.tsx", glob), true);
    assert.equal(matches("src/foo.js", glob), false);
  });

  it("expands braces and honours bracket expressions", () => {
    assert.equal(matches("pkg/a.spec.mts", "**/*.spec.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"), true);
    assert.equal(matches("pkg/a.js", "**/*.spec.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"), false);
    assert.equal(matches("src/a.test.cjs", "**/*.{test,spec}.?(c|m)[jt]s?(x)"), true);
    assert.equal(matches("src/a.js", "**/*.{test,spec}.?(c|m)[jt]s?(x)"), false);
  });
});

describe("glob matching: bounded runtime", () => {
  it("matches a realistic workload in milliseconds, not minutes", () => {
    // The pattern that produced the pathological regex, against paths the length of Prettier's.
    const glob = "**/?(*.)+(spec|test).[jt]s?(x)";
    const paths: string[] = [];
    for (let i = 0; i < 100; i++) {
      const depth = 2 + (i % 5);
      const segments = Array.from({ length: depth }, (_unused, d) => `segment${i}${"x".repeat(4 + ((i + d) % 9))}`);
      paths.push(`${segments.join("/")}/module${"y".repeat(i % 12)}.js`);
    }
    // Lengths span the range where the old implementation went from milliseconds to minutes.
    const lengths = paths.map((p) => p.length);
    assert.ok(Math.max(...lengths) >= 60, `workload must reach Prettier-like lengths, got max ${Math.max(...lengths)}`);

    const started = Date.now();
    let matched = 0;
    for (let round = 0; round < 100; round++) {
      for (const path of paths) if (matchesGlob(path, glob)) matched += 1;
    }
    const elapsedMs = Date.now() - started;

    assert.equal(matched, 0, "these paths are all non-matching - the worst case for a backtracking matcher");
    // Generous by design. This distinguishes milliseconds from minutes, not one machine's nanoseconds
    // from another's. The deleted implementation would not have finished this workload in a day.
    assert.ok(elapsedMs < 5000, `10,000 matches took ${elapsedMs} ms - expected well under 5000`);
  });

  it("returns immediately on the single input that took ~30 seconds", () => {
    // 28 characters before the separator was 30,096 ms with the deleted matcher; 120 is far beyond it.
    const adversarial = `${"a".repeat(120)}/x.js`;
    const started = Date.now();
    assert.equal(matchesGlob(adversarial, "**/?(*.)+(spec|test).[jt]s?(x)"), false);
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 1000, `single adversarial match took ${elapsedMs} ms`);
  });
});
