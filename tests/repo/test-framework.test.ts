// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Phase 01 (2026-08-26): the engine must recognise a repository's tests when that repository relies
 * on its test runner's own defaults, and must refuse to propose a selection when it cannot.
 *
 * Every fixture below reproduces the layout of a real repository from the Phase 01 baseline
 * (docs/research/2026-08-26-phase01-repo-agnostic-baseline.md), where the measured result was zero
 * or near-zero test files discovered.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { analyzeRepository } from "../../src/repo/analyzer.js";
import { matchesGlob } from "../../src/repo/test-discovery.js";
import { defaultIncludesFor, detectDeclaredFrameworks } from "../../src/repo/test-framework.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "diffci-framework-"));
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("extended-glob matching", () => {
  it("matches vitest's and jest's own default include globs", () => {
    // These are the exact defaults the runners ship with. Before Phase 01 the `?(x)` group reached
    // RegExp unchanged, where it means "an optional preceding character followed by a literal x", so
    // these globs matched nothing at all.
    const vitest = "**/*.{test,spec}.?(c|m)[jt]s?(x)";
    assert.ok(matchesGlob("src/a.test.ts", vitest));
    assert.ok(matchesGlob("src/a.spec.mts", vitest));
    assert.ok(matchesGlob("packages/core/src/a.test.tsx", vitest));
    assert.ok(matchesGlob("a.test.cjs", vitest));
    assert.ok(!matchesGlob("src/a.ts", vitest));
    assert.ok(!matchesGlob("src/a.test.tsy", vitest));

    const jest = "**/__tests__/**/*.[jt]s?(x)";
    assert.ok(matchesGlob("__tests__/base.js", jest), "immerjs/immer's real layout");
    assert.ok(matchesGlob("packages/core/src/__tests__/utils.test.ts", jest));
    assert.ok(matchesGlob("__tests__/nested/deep/case.tsx", jest));
    assert.ok(!matchesGlob("__tests__/snap.snap", jest));
  });

  it("treats a bare ? as a single-character wildcard that never crosses a path separator", () => {
    assert.ok(matchesGlob("src/a1.test.ts", "src/a?.test.ts"));
    assert.ok(!matchesGlob("src/a.test.ts", "src/a?.test.ts"));
    assert.ok(!matchesGlob("src/a/b.test.ts", "src/a?b.test.ts"));
  });

  it("widens unsupported negation rather than silently matching nothing", () => {
    // `!(...)` is not modelled. Over-inclusion counts extra files as tests; under-inclusion empties
    // the test universe. Only the first of those is a safe way to be wrong here.
    assert.ok(matchesGlob("test/foo.js", "test/!(fixtures).js"));
  });
});

describe("declared test frameworks", () => {
  it("detects a framework from a dependency and from a script, and reports which", () => {
    const fromDependency = detectDeclaredFrameworks({ devDependencies: { vitest: "^4.0.0" } });
    assert.deepEqual(fromDependency.frameworks, ["vitest"]);
    assert.equal(fromDependency.evidence.vitest, "dependency:vitest");

    const fromScript = detectDeclaredFrameworks({ scripts: { test: "mocha --recursive" } });
    assert.deepEqual(fromScript.frameworks, ["mocha"]);
    assert.equal(fromScript.evidence.mocha, "script:test");

    const nodeTest = detectDeclaredFrameworks({ scripts: { test: "tsx --test \"tests/**/*.test.ts\"" } });
    assert.deepEqual(nodeTest.frameworks, ["node:test"]);

    assert.deepEqual(detectDeclaredFrameworks({ scripts: { build: "tsc" } }).frameworks, []);
    assert.deepEqual(detectDeclaredFrameworks(undefined).frameworks, []);
  });

  it("does not mistake an unrelated word for a framework", () => {
    // "avatars", "jester", "mochaccino" - substring matching would claim all three.
    const result = detectDeclaredFrameworks({
      scripts: { build: "node scripts/build-avatars.js && node scripts/jester.js" },
    });
    assert.deepEqual(result.frameworks, []);
  });

  it("contributes each declared framework's own default includes", () => {
    assert.ok(defaultIncludesFor(["jest"]).includes("**/__tests__/**/*.[jt]s?(x)"));
    assert.ok(defaultIncludesFor(["ava"]).some((p) => p.startsWith("test/**")));
    assert.deepEqual(defaultIncludesFor([]), []);
  });
});

describe("test universe and the blind-spot fact", () => {
  it("discovers a suite that relies purely on the runner's defaults (immerjs/immer's layout)", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "immer-like", devDependencies: { vitest: "^4.0.0" } }));
      write(root, "vitest.config.ts", `export default { test: { include: ["**/__tests__/**/*.[jt]s?(x)"] } }`);
      write(root, "src/index.ts", "export const x = 1;\n");
      write(root, "__tests__/base.js", "test('base', () => {});\n");
      write(root, "__tests__/curry.js", "test('curry', () => {});\n");
      write(root, "__tests__/__snapshots__/base.js.snap", "// snapshot\n");

      const profile = analyzeRepository({ repoPath: root });

      assert.deepEqual(profile.testFilePaths, ["__tests__/base.js", "__tests__/curry.js"]);
      assert.equal(profile.testUniverse?.blindSpot, false);
      assert.deepEqual(profile.testUniverse?.declaredFrameworks, ["vitest"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers an ava suite with no config file at all (sindresorhus/execa's layout)", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "execa-like", devDependencies: { ava: "^6.0.0" } }));
      write(root, "index.js", "export const run = () => {};\n");
      write(root, "test/main.js", "test('main', () => {});\n");
      write(root, "test/stdio/output.js", "test('output', () => {});\n");

      const profile = analyzeRepository({ repoPath: root });

      assert.deepEqual(profile.testFilePaths, ["test/main.js", "test/stdio/output.js"]);
      assert.equal(profile.testUniverse?.blindSpot, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours a framework's own default excludes, but never overrules the repository itself", () => {
    // execa keeps 193 process fixtures under test/fixtures/. ava's defaults exclude them, so counting
    // them as tests would put a wrong denominator under every savings figure. A file the repository
    // named a test - by the conventional `.test.` infix or its own explicit config glob - stays a
    // test wherever it lives, because that is the repository's own declaration, not an inference.
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "execa-like", devDependencies: { ava: "^6.0.0" } }));
      write(root, "test/main.js", "test('main', () => {});\n");
      write(root, "test/fixtures/noop.js", "process.exit(0)\n");
      write(root, "test/helpers/setup.js", "export const setup = () => {};\n");
      write(root, "test/fixtures/regression.test.js", "test('named a test by convention', () => {});\n");

      const profile = analyzeRepository({ repoPath: root });

      assert.deepEqual(profile.testFilePaths, ["test/fixtures/regression.test.js", "test/main.js"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds tests under packages/ even when a top-level test/ directory exists (docusaurus's layout)", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "monorepo", devDependencies: { vitest: "^4.0.0" } }));
      write(root, "test/root-level.test.ts", "test('root', () => {});\n");
      write(root, "packages/core/src/__tests__/utils.test.ts", "test('utils', () => {});\n");
      write(root, "packages/theme/src/__tests__/theme.test.ts", "test('theme', () => {});\n");

      const profile = analyzeRepository({ repoPath: root });

      assert.equal(profile.testFilePaths.length, 3, "a root test/ dir must not suppress packages/");
      assert.ok(profile.testFilePaths.includes("packages/core/src/__tests__/utils.test.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a blind spot when a framework is declared and nothing is discoverable", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "opaque", devDependencies: { vitest: "^4.0.0" } }));
      write(root, "vitest.config.ts", `export default { test: { include: [someRuntimeComputedGlobs] } }`);
      write(root, "src/index.ts", "export const x = 1;\n");
      write(root, "suites/thing.check.ts", "// a test, under a name nothing recognises\n");

      const profile = analyzeRepository({ repoPath: root });

      assert.equal(profile.testFilePaths.length, 0);
      assert.equal(profile.testUniverse?.blindSpot, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not call a repository with no test framework at all a blind spot", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "no-tests", scripts: { build: "tsc" } }));
      write(root, "src/index.ts", "export const x = 1;\n");

      const profile = analyzeRepository({ repoPath: root });

      assert.equal(profile.testUniverse?.blindSpot, false, "declaring no framework is not the same as hiding one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
