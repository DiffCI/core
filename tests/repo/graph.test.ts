// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import {
  buildDependencyGraph,
  graphToJson,
  refineConfidenceForDelta,
  explainGraphConfidence,
  validateDependencyGraph,
} from "../../src/repo/graph.js";

interface FixtureFiles {
  [path: string]: string;
}

function createTempRepo(files: FixtureFiles): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-repo-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: {
          "@/*": ["./src/*"],
        },
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: ["**/*.ts"],
    }),
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(dir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  return dir;
}

async function buildFixture(files: FixtureFiles) {
  const repoPath = createTempRepo(files);
  return buildDependencyGraph({ repoPath, excludeDirs: ["node_modules"] });
}

function nodePaths(result: Awaited<ReturnType<typeof buildFixture>>, file: string) {
  const graph = result.graph;
  return {
    dependencies: () => graph.dependenciesOf(file),
    dependents: () => graph.dependentsOf(file),
    transitiveDependents: () => graph.transitiveDependentsOf(file),
    transitiveDependencies: () => graph.transitiveDependenciesOf(file),
  };
}

describe("DependencyGraph fixtures", () => {
  it("direct dependency", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "export const b = 1;\n",
    });
    assert.strictEqual(result.confidence, "COMPLETE");

    const a = nodePaths(result, "src/A.ts");
    assert.deepStrictEqual(a.dependencies(), ["src/B.ts"]);

    const b = nodePaths(result, "src/B.ts");
    assert.deepStrictEqual(b.dependents(), ["src/A.ts"]);
  });

  it("transitive dependency", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    assert.deepStrictEqual(nodePaths(result, "src/A.ts").transitiveDependencies(), [
      "src/B.ts",
      "src/C.ts",
    ]);
    assert.deepStrictEqual(nodePaths(result, "src/C.ts").transitiveDependents(), [
      "src/A.ts",
      "src/B.ts",
    ]);
  });

  it("diamond dependency", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B'; import { c } from './C';\n",
      "src/B.ts": "import { d } from './D';\n",
      "src/C.ts": "import { d } from './D';\n",
      "src/D.ts": "export const d = 1;\n",
    });

    const d = nodePaths(result, "src/D.ts");
    assert.deepStrictEqual(d.transitiveDependents().sort(), [
      "src/A.ts",
      "src/B.ts",
      "src/C.ts",
    ]);

    const a = nodePaths(result, "src/A.ts");
    assert.deepStrictEqual(a.transitiveDependencies().sort(), [
      "src/B.ts",
      "src/C.ts",
      "src/D.ts",
    ]);
  });

  it("handles cycles without infinite looping", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "import { a } from './A';\n",
    });

    const a = nodePaths(result, "src/A.ts");
    const transitive = a.transitiveDependencies();
    assert.equal(transitive.includes("src/B.ts"), true);
    assert.equal(transitive.includes("src/C.ts"), true);
    assert.equal(transitive.length, 2);
  });

  it("barrel re-export propagates reverse dependencies", async () => {
    const result = await buildFixture({
      "src/Consumer.ts": "import { Button } from './components';\n",
      "src/components/index.ts": "export { Button } from './Button';\n",
      "src/components/Button.ts": "export function Button() {}\n",
    });

    assert.deepStrictEqual(nodePaths(result, "src/components/index.ts").dependents(), [
      "src/Consumer.ts",
    ]);

    assert.deepStrictEqual(
      nodePaths(result, "src/components/Button.ts").transitiveDependents(),
      ["src/Consumer.ts", "src/components/index.ts"],
    );
  });

  it("export star propagates through barrel", async () => {
    const result = await buildFixture({
      "src/Consumer.ts": "import { Button } from './components';\n",
      "src/components/index.ts": "export * from './Button';\n",
      "src/components/Button.ts": "export function Button() {}\n",
    });

    assert.deepStrictEqual(
      nodePaths(result, "src/components/Button.ts").transitiveDependents(),
      ["src/Consumer.ts", "src/components/index.ts"],
    );
  });

  it("resolves tsconfig path aliases", async () => {
    const result = await buildFixture({
      "src/app.ts": "import { foo } from '@/lib/foo';\n",
      "src/lib/foo.ts": "export const foo = 1;\n",
    });

    assert.deepStrictEqual(nodePaths(result, "src/app.ts").dependencies(), [
      "src/lib/foo.ts",
    ]);
    assert.deepStrictEqual(nodePaths(result, "src/lib/foo.ts").dependents(), [
      "src/app.ts",
    ]);
  });

  it("creates edges for dynamic literal imports", async () => {
    const result = await buildFixture({
      "src/A.ts": "export async function load() { const m = await import('./module'); return m; }\n",
      "src/module.ts": "export const value = 1;\n",
    });

    const edge = result.graph.edges.find(
      (e) => e.from === "src/A.ts" && e.to === "src/module.ts",
    );
    assert.ok(edge);
    assert.strictEqual(edge!.kind, "dynamic-import");
    assert.strictEqual(result.confidence, "COMPLETE");
  });

  it("records dynamic computed imports as unresolved", async () => {
    const result = await buildFixture({
      "src/A.ts": "export async function load(name: string) { return import(`./${name}`); }\n",
    });

    assert.strictEqual(result.confidence, "UNSAFE");
    const unresolved = result.unresolved.find(
      (u) => u.specifier.includes("${name}") || u.specifier.includes("__computed"),
    );
    assert.ok(unresolved);
    assert.strictEqual(unresolved!.dynamic, true);
  });

  it("records missing internal modules as unresolved", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { x } from './missing';\n",
    });

    assert.strictEqual(result.confidence, "UNSAFE");
    const unresolved = result.unresolved.find((u) => u.specifier === "./missing");
    assert.ok(unresolved);
    assert.strictEqual(unresolved!.dynamic, false);
  });

  it("classifies type-only imports separately", async () => {
    const result = await buildFixture({
      "src/A.ts": "import type { T } from './types';\n",
      "src/types.ts": "export interface T {}\n",
    });

    const edge = result.graph.edges.find((e) => e.from === "src/A.ts");
    assert.ok(edge);
    assert.strictEqual(edge!.kind, "type-import");
  });

  it("classifies imports whose specifiers are all inline type as type-only", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { type T, type U } from './types';\nexport { type T } from './types';\n",
      "src/B.ts": "import { type T, value } from './types';\n",
      "src/C.ts": "import def, { type T } from './types';\n",
      "src/types.ts": "export interface T {}\nexport interface U {}\nexport const value = 1;\nexport default 2;\n",
    });

    const kinds = (from: string) => result.graph.edges.filter((e) => e.from === from).map((e) => e.kind);
    assert.deepStrictEqual(kinds("src/A.ts"), ["type-import"]);
    assert.deepStrictEqual(kinds("src/B.ts"), ["import"]);
    assert.deepStrictEqual(kinds("src/C.ts"), ["import"]);
    assert.deepStrictEqual(result.graph.transitiveRuntimeDependentsOf!("src/types.ts"), ["src/B.ts", "src/C.ts"]);
  });

  it("keeps inline type imports as runtime edges under verbatimModuleSyntax", async () => {
    const result = await buildFixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", verbatimModuleSyntax: true, noEmit: true }, include: ["**/*.ts"] }),
      "src/A.ts": "import { type T } from './types';\n",
      "src/types.ts": "export interface T {}\n",
    });

    const edge = result.graph.edges.find((e) => e.from === "src/A.ts");
    assert.strictEqual(edge?.kind, "import");
  });

  it("treats vi.mock and jest.mock targets as dependencies of the test", async () => {
    const result = await buildFixture({
      "src/api.ts": "export const fetchUser = () => 1;\n",
      "src/db.ts": "export const query = () => 1;\n",
      "src/a.test.ts": "import { vi } from 'vitest';\nvi.mock('./api', () => ({ fetchUser: vi.fn() }));\nconst actual = await vi.importActual('./db');\n",
      "src/b.test.ts": "jest.mock('./api');\njest.mock('./virtual-module', () => ({}), { virtual: true });\n",
    });

    assert.deepStrictEqual(result.graph.transitiveRuntimeDependentsOf!("src/api.ts"), ["src/a.test.ts", "src/b.test.ts"]);
    assert.deepStrictEqual(result.graph.transitiveRuntimeDependentsOf!("src/db.ts"), ["src/a.test.ts"]);
    assert.ok(!result.unresolved.some((u) => u.specifier === "./virtual-module"));
    assert.strictEqual(result.confidence, "COMPLETE");
  });

  it("supports CommonJS require with string literals", async () => {
    const result = await buildFixture({
      "src/A.ts": "const b = require('./b');\n",
      "src/b.ts": "export = 1;\n",
    });

    const edge = result.graph.edges.find(
      (e) => e.from === "src/A.ts" && e.to === "src/b.ts",
    );
    assert.ok(edge);
    assert.strictEqual(edge!.kind, "require");
  });

  it("does not treat external packages as internal edges", async () => {
    const result = await buildFixture({
      "src/A.ts": "import React from 'react';\n",
    });

    const edge = result.graph.edges.find((e) => e.from === "src/A.ts");
    assert.strictEqual(edge, undefined);
    const reference = result.references.find(
      (r) => r.specifier === "react" && r.resolution === "external-package",
    );
    assert.ok(reference);
    assert.strictEqual(result.unresolved.length, 0);
  });

  it("produces deterministic JSON output", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    const json1 = JSON.stringify(result.graph);
    const json2 = JSON.stringify(result.graph);
    assert.strictEqual(json1, json2);
  });

  it("safety A: unresolved internal dependencies prevent COMPLETE confidence", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { x } from './missing';\n",
    });
    assert.notStrictEqual(result.confidence, "COMPLETE");
    assert.ok(result.unresolved.length > 0);
  });

  it("safety B: platform built-ins do not reduce confidence", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { readFileSync } from 'node:fs';\n",
    });

    const ref = result.references.find((r) => r.specifier === "node:fs");
    assert.ok(ref);
    assert.strictEqual(ref!.resolution, "platform-builtin");
    assert.strictEqual(result.confidence, "COMPLETE");
  });

  it("safety C: asset imports have reversible reverse-impact edges", async () => {
    const result = await buildFixture({
      "src/A.ts": "import styles from './styles.module.css';\n",
      "src/styles.module.css": ".btn { color: red; }\n",
    });

    const assetEdge = result.graph.edges.find(
      (e) => e.from === "src/A.ts" && e.to === "src/styles.module.css",
    );
    assert.ok(assetEdge);
    assert.strictEqual(assetEdge!.kind, "asset");
    assert.deepStrictEqual(
      result.graph.dependentsOf("src/styles.module.css"),
      ["src/A.ts"],
    );
    assert.strictEqual(result.references.find((r) => r.resolution === "internal-asset")?.resolution, "internal-asset");
  });

  it("safety D: every internal edge has a reverse edge", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\nimport { c } from './C';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    for (const edge of result.graph.edges) {
      assert.ok(
        result.graph.nodes.some((n) => n.path === edge.from),
        `edge from missing node ${edge.from}`,
      );
      assert.ok(
        result.graph.nodes.some((n) => n.path === edge.to),
        `edge to missing node ${edge.to}`,
      );
      const reverse = result.graph.reverse[edge.to];
      assert.ok(
        reverse?.includes(edge.from),
        `missing reverse edge ${edge.to} -> ${edge.from}`,
      );
    }
  });

  it("safety E: traversal terminates on cycles", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { a } from './A';\n",
    });

    const a = nodePaths(result, "src/A.ts");
    const deps = a.transitiveDependencies();
    assert.deepStrictEqual(deps, ["src/B.ts"]);

    const b = nodePaths(result, "src/B.ts");
    assert.deepStrictEqual(b.transitiveDependents(), ["src/A.ts"]);
  });

  it("safety F: graphToJson output is deterministic", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    const json1 = graphToJson(result);
    const json2 = graphToJson(result);
    assert.strictEqual(json1, json2);
  });

  it("safety G: missing internal targets are not silently discarded", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { x } from './missing';\n",
    });

    const unresolved = result.unresolved.find((u) => u.specifier === "./missing");
    assert.ok(unresolved);
    assert.strictEqual(unresolved!.importer, "src/A.ts");
  });

  it("safety H: validateDependencyGraph reports no critical findings for consistent graph", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });
    const report = validateDependencyGraph(result.graph);
    assert.strictEqual(report.criticalCount, 0);
    assert.strictEqual(report.stats.edgeCount, result.graph.edges.length);
  });
});

// Stage 1B regression tests (2026-08-21, docs/research/2026-08-21-stage1b-*.md): reachability-aware
// per-delta confidence refinement. Real fixtures via buildFixture()/buildDependencyGraph(), not
// hand-rolled DependencyGraphResult mocks - the exact class of fixture/production mismatch that first
// surfaced as a false regression while building this feature (see the commit history) only shows up
// against hand-rolled fixtures, not real graph construction, so these tests deliberately use the real
// pipeline end to end.
describe("refineConfidenceForDelta", () => {
  it("narrows UNSAFE to COMPLETE when the unresolved import is unreachable from the delta's changed files", async () => {
    const result = await buildFixture({
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
      "src/unrelated.ts": "export const z = 1;\n",
    });
    assert.strictEqual(result.confidence, "UNSAFE", "the raw, delta-independent confidence is still UNSAFE");
    assert.strictEqual(refineConfidenceForDelta(result, ["src/unrelated.ts"]), "COMPLETE", "unrelated.ts has no connection to broken.ts in either direction");
  });

  it("keeps UNSAFE when the changed file IS the one with the unresolved import", async () => {
    const result = await buildFixture({
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
      "src/unrelated.ts": "export const z = 1;\n",
    });
    assert.strictEqual(refineConfidenceForDelta(result, ["src/broken.ts"]), "UNSAFE");
  });

  it("keeps UNSAFE when the changed file transitively DEPENDS ON the file with the unresolved import", async () => {
    const result = await buildFixture({
      "src/entry.ts": "import { y } from './broken';\n",
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
    });
    assert.strictEqual(refineConfidenceForDelta(result, ["src/entry.ts"]), "UNSAFE", "entry.ts depends on broken.ts, so its own incompleteness is inherited");
  });

  it("narrows when the file with the unresolved import already depends on the changed file", async () => {
    const result = await buildFixture({
      "src/shared.ts": "export const s = 1;\n",
      "src/broken.ts": "import { s } from './shared';\nimport { x } from './missing';\n",
    });
    // broken.ts and everything depending on it are affected by shared.ts already; its missing edge
    // cannot add a test the selection lacks (2026-11-03, reversing the 2026-08-21 expectation).
    assert.strictEqual(refineConfidenceForDelta(result, ["src/shared.ts"]), "COMPLETE");
  });

  it("passes through a confidence that was never UNSAFE, unchanged, with no narrowing applied", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "export const b = 1;\n",
    });
    assert.strictEqual(result.confidence, "COMPLETE");
    assert.strictEqual(refineConfidenceForDelta(result, ["src/A.ts"]), "COMPLETE");
    assert.strictEqual(refineConfidenceForDelta(result, []), "COMPLETE", "even with no changed files at all - nothing to narrow when it was never UNSAFE");
  });

  it("never narrows below PARTIAL when project references were used, even after successful narrowing", async () => {
    // Reuses the exact fixture shape the dedicated project-references test file already establishes
    // produces resolvedViaProjectReferences: true - see graph.project-references.test.ts. This
    // synthesizes the same effect directly on a real, otherwise-UNSAFE result to test the interaction
    // specifically, rather than duplicating that file's full multi-project fixture setup.
    const result = await buildFixture({
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
      "src/unrelated.ts": "export const z = 1;\n",
    });
    const withProjectReferences = { ...result, resolvedViaProjectReferences: true };
    assert.strictEqual(refineConfidenceForDelta(withProjectReferences, ["src/unrelated.ts"]), "PARTIAL", "narrowing must respect the project-references cap, not jump straight to COMPLETE");
  });
});

// Stage 1B regression test (2026-08-21, docs/research/2026-08-21-stage1b-*.md): tsconfig-file-scope
// fallback. Root-caused in Stage 1A against the real sindresorhus/execa: reproduces the exact shape
// (tsconfig scoped to declaration-only validation via "files", no "include") against a synthetic
// fixture with real .js source under lib/ - a directory the default source-root convention already
// covers, so this exercises the actual production discovery path end to end, not a mock.
describe("createProgram tsconfig-file-scope fallback", () => {
  it("discovers real .js source when the tsconfig is scoped to declaration-only validation", async () => {
    // Deliberately NO allowJs here, matching the real sindresorhus/execa tsconfig this reproduces - a
    // tsconfig scoped to declaration-only validation was never designed to compile .js at all, so it
    // correctly never sets allowJs itself. The fallback must set it automatically when it fires (see
    // createProgram()'s doc comment) - this test would fail again if that forcing were ever removed.
    const result = await buildFixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", types: ["node"] },
        files: ["index.d.ts"],
      }),
      "index.d.ts": "export declare function run(): void;\n",
      "lib/helper.js": "export function helper() { return 1; }\n",
      "lib/main.js": "import { helper } from './helper.js';\nexport function run() { return helper(); }\n",
    });

    assert.ok(result.profile.stats.sourceFiles > 0, "the fallback must have discovered real .js source, not left the graph empty");
    const helperNode = result.graph.nodes.find((n) => n.path === "lib/helper.js");
    assert.ok(helperNode, "lib/helper.js must be a real graph node");
    assert.deepStrictEqual(result.graph.dependentsOf("lib/helper.js"), ["lib/main.js"], "the real import edge between the two fallback-discovered files must be resolved, not just the files present");
  });

  it("does not trigger the fallback when the tsconfig's file list already includes real source (not scoped to declarations only)", async () => {
    const result = await buildFixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", allowJs: true },
        files: ["lib/main.js"],
      }),
      "lib/main.js": "export function run() { return 1; }\n",
      "lib/unrelated.js": "export function neverImported() { return 2; }\n",
    });

    // The fallback must not blanket-add every discovered file when the tsconfig already names real
    // source - only lib/main.js (what the tsconfig actually specified) should be a graph node; adding
    // lib/unrelated.js too would silently override a tsconfig that was never actually mis-scoped.
    assert.ok(result.graph.nodes.some((n) => n.path === "lib/main.js"));
    assert.ok(!result.graph.nodes.some((n) => n.path === "lib/unrelated.js"), "the fallback trigger (every fileName is a .d.ts) must not fire here - lib/main.js is real source, not a declaration file");
  });
});
describe("bundler import-query suffixes (2026-08-23, deepseek-harness Phase 5)", () => {
  it("`?inline` / `?raw` / `?url` asset imports resolve to the real asset instead of being unresolved", async () => {
    const result = await buildFixture({
      "src/styles.ts": "import base from '../styles/base.css?inline';\nimport raw from './notes.txt?raw';\nimport url from '@/logo.svg?url';\nexport const all = [base, raw, url];\n",
      "styles/base.css": "body{}\n",
      "src/notes.txt": "n\n",
      "src/logo.svg": "<svg/>\n",
    });
    assert.strictEqual(result.confidence, "COMPLETE", JSON.stringify(result.unresolved));
    assert.deepStrictEqual(result.unresolved, []);
    assert.deepStrictEqual(nodePaths(result, "src/styles.ts").dependencies(), ["src/logo.svg", "src/notes.txt", "styles/base.css"]);
    assert.deepStrictEqual(nodePaths(result, "styles/base.css").dependents(), ["src/styles.ts"]);
  });

  it("`?worker` on a source module resolves to that module; a query on a MISSING file is still unresolved", async () => {
    const result = await buildFixture({
      "src/main.ts": "import W from './worker?worker';\nimport missing from './gone.css?inline';\nexport const x = [W, missing];\n",
      "src/worker.ts": "export default 1;\n",
    });
    assert.deepStrictEqual(nodePaths(result, "src/main.ts").dependencies(), ["src/worker.ts"]);
    assert.strictEqual(result.unresolved.length, 1);
    assert.strictEqual(result.unresolved[0]?.specifier, "./gone.css?inline");
    assert.strictEqual(result.confidence, "UNSAFE");
  });

  it("a leading `#` subpath import is never truncated", async () => {
    const result = await buildFixture({
      "src/main.ts": "import { x } from '#internal/x';\nexport const y = x;\n",
    });
    assert.strictEqual(result.unresolved[0]?.specifier, "#internal/x");
  });
});

describe("nested-package test visibility (2026-08-24, biomejs/biome finding)", () => {
  // Deliberately NOT buildFixture()/createTempRepo(): that helper always writes a ROOT tsconfig.json
  // with a broad `include: ["**/*.ts"]`, which `ts.findConfigFile()` finds first and which sweeps up
  // every .ts file repo-wide regardless of any NESTED package tsconfig's own `exclude` - so it never
  // exercises the "no root tsconfig, only nested per-package configs" code path this fix targets (a
  // fixture built with buildFixture() cannot reproduce biome's actual structure). This helper creates a
  // repo with NO root tsconfig.json at all, matching biomejs/biome exactly.
  function buildNoRootTsconfigFixture(files: FixtureFiles) {
    const dir = mkdtempSync(join(tmpdir(), "diffci-no-root-tsconfig-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    for (const [relativePath, content] of Object.entries(files)) {
      const full = join(dir, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules"] });
  }

  it("a test file excluded from its package's own tsconfig still becomes a graph test node", async () => {
    const result = await buildNoRootTsconfigFixture({
      "packages/js-api/package.json": JSON.stringify({ name: "js-api", version: "1.0.0" }),
      "packages/js-api/tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2020", module: "commonjs" }, exclude: ["./tests", "./dist"], include: ["./src"] }),
      "packages/js-api/src/index.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "packages/js-api/tests/index.test.ts": "import { add } from '../src/index.js';\nif (add(1,1) !== 2) throw new Error('x');\n",
    });
    const testNode = result.graph.nodes.find((n) => n.path === "packages/js-api/tests/index.test.ts");
    assert.ok(testNode, "the excluded test file must still be a graph node");
    assert.strictEqual(testNode?.isTest, true);
    assert.strictEqual(result.profile.stats.testFiles, 1);
    // The src file the test imports is unaffected - still resolved normally via nested-tsconfig discovery.
    const srcNode = result.graph.nodes.find((n) => n.path === "packages/js-api/src/index.ts");
    assert.ok(srcNode);
    assert.strictEqual(srcNode?.isTest, false);
  });

  it("does not add duplicate nodes when the test file IS already visible to the TS program (root-tsconfig repo)", async () => {
    const result = await buildFixture({
      "src/a.ts": "export const a = 1;\n",
      "src/a.test.ts": "import { a } from './a.js';\nif (a !== 1) throw new Error();\n",
    });
    const matches = result.graph.nodes.filter((n) => n.path === "src/a.test.ts");
    assert.strictEqual(matches.length, 1, "no duplicate node for a normally-visible test file");
    assert.strictEqual(matches[0]?.isTest, true);
    // Confirms it took the normal path (real edge to its import), not the union-merge path.
    assert.deepStrictEqual(result.graph.dependenciesOf("src/a.test.ts"), ["src/a.ts"]);
  });

  it("does not add a duplicate node when the SAME excluded test file is also reachable via a nested-discovery-visible sibling package (no-root-tsconfig repo)", async () => {
    const result = await buildNoRootTsconfigFixture({
      "packages/js-api/package.json": JSON.stringify({ name: "js-api", version: "1.0.0" }),
      "packages/js-api/tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2020" }, exclude: ["./tests"], include: ["./src", "./tests"] }),
      "packages/js-api/src/index.ts": "export const x = 1;\n",
      "packages/js-api/tests/index.test.ts": "export const t = 1;\n",
    });
    // This package's tsconfig actually includes ./tests too (a repo that does NOT exclude tests from
    // its own program) - the file is visible to the TS program already; the union step must not
    // duplicate it.
    const matches = result.graph.nodes.filter((n) => n.path === "packages/js-api/tests/index.test.ts");
    assert.strictEqual(matches.length, 1);
  });

  it("never grants any visibility to non-JS/TS (e.g. Rust) files - this is not Rust support", async () => {
    const result = await buildNoRootTsconfigFixture({
      "packages/js-api/package.json": JSON.stringify({ name: "js-api", version: "1.0.0" }),
      "packages/js-api/tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2020" }, exclude: ["./tests"], include: ["./src"] }),
      "packages/js-api/src/index.ts": "export const x = 1;\n",
      "packages/js-api/tests/index.test.ts": "export const t = 1;\n",
      "crates/fake_rust/lib.rs": "fn add(a: i32, b: i32) -> i32 { a + b }\n",
      "crates/fake_rust/tests/add.rs": "#[test]\nfn it_adds() { assert_eq!(1 + 1, 2); }\n",
    });
    const rustPaths = result.graph.nodes.map((n) => n.path).filter((p) => p.endsWith(".rs"));
    assert.deepStrictEqual(rustPaths, [], "no .rs file of any kind becomes a graph node");
    assert.ok(!result.profile.testFilePaths.some((p) => p.endsWith(".rs")));
    // The JS/TS side of the SAME repo is still correctly fixed alongside the untouched Rust side.
    assert.strictEqual(result.graph.nodes.find((n) => n.path === "packages/js-api/tests/index.test.ts")?.isTest, true);
  });

  it("a test excluded by tsconfig retains a resolvable import edge", async () => {
    const result = await buildNoRootTsconfigFixture({
      "packages/js-api/package.json": JSON.stringify({ name: "js-api", version: "1.0.0" }),
      "packages/js-api/tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2020" }, exclude: ["./tests"], include: ["./src"] }),
      "packages/js-api/src/index.ts": "export const x = 1;\n",
      "packages/js-api/tests/index.test.ts": "import { x } from '../src/index.js';\nexport const t = x;\n",
    });
    // Tests excluded by a source-only tsconfig still need their imports traced; otherwise a
    // source change could incorrectly appear to affect no tests.
    const deps = result.graph.dependenciesOf("packages/js-api/tests/index.test.ts");
    assert.deepStrictEqual(deps, ["packages/js-api/src/index.ts"]);
    assert.strictEqual(result.graph.nodes.find((n) => n.path === "packages/js-api/tests/index.test.ts")?.isTest, true);
  });
});

describe("tsconfig discovery is clamped to the repository (Phase 01 F5, 2026-08-26)", () => {
  // createProgram() used ts.findConfigFile(repoPath, ...), which starts at repoPath and walks UP. A
  // repository cloned beneath any directory holding a tsconfig.json was therefore analysed against
  // that ANCESTOR's project. Known and unfixed since 2026-08-20 (flagged in a comment in
  // src/research/repository/collector.ts). It never affected the container pipeline, where clones
  // land at /repos/<name>, but it silently corrupted every local run - including the runs this phase
  // uses to verify itself.
  it("does not adopt an ancestor's tsconfig.json when the repository has none", async () => {
    const outer = mkdtempSync(join(tmpdir(), "diffci-ancestor-"));
    try {
      writeFileSync(
        join(outer, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2022", moduleResolution: "Bundler", noEmit: true }, include: ["**/*.ts"] }),
      );
      writeFileSync(join(outer, "ancestor-only.ts"), "export const fromAncestor = 1;\n");

      const inner = join(outer, "nested-repo");
      mkdirSync(join(inner, "src"), { recursive: true });
      writeFileSync(join(inner, "package.json"), JSON.stringify({ name: "nested", version: "1.0.0", type: "module" }));
      writeFileSync(join(inner, "src/index.ts"), "export const own = 1;\n");

      const result = await buildDependencyGraph({ repoPath: inner });

      assert.ok(
        !result.graph.nodes.some((n) => n.path.includes("ancestor-only")),
        `the ancestor's source must never enter this repository's graph: ${result.graph.nodes.map((n) => n.path).join(", ")}`,
      );
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe("runtime module references", () => {
  // A literal import() names its only possible target. When that target is missing at HEAD (a
  // generated file such as a framework's server bundle), it cannot load an unrelated changed file,
  // so it must not force full validation for every delta in the repository.
  it("narrows an unresolved literal import() like any other unresolved import", async () => {
    const root = createTempRepo({
      "src/changed.ts": "export const value = 1;",
      "tests/changed.test.ts": "import { value } from '../src/changed'; export const v = value;",
      "scripts/bootstrap.ts": "export const start = () => import('./server.js');",
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.ok(result.unresolved.some(ref => ref.importer === "scripts/bootstrap.ts" && ref.dynamic && !ref.computed));
      assert.notEqual(refineConfidenceForDelta(result, ["src/changed.ts"]), "UNSAFE");
      assert.equal(refineConfidenceForDelta(result, ["scripts/bootstrap.ts"]), "UNSAFE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat a local function named require as a module load", async () => {
    const root = createTempRepo({
      "src/check.ts": "const require = (condition: boolean, code: string) => { if (!condition) throw new Error(code); };\nexport const check = (value: unknown) => require(value === 1, 'value-required');",
      "src/loader.ts": "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const load = (name: string) => require(name);",
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.ok(!result.unresolved.some(ref => ref.importer === "src/check.ts"), JSON.stringify(result.unresolved));
      assert.ok(result.unresolved.some(ref => ref.importer === "src/loader.ts" && ref.computed));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [name, source] of Object.entries({
    "variable import": "let path = './changed'; export const load = () => import(path);",
    "conditional import": "export const load = () => import(true ? './changed' : './other');",
    "variable require": "export const load = (path: string) => require(path);",
    "interpolated import from the repository root": "export const load = (name: string) => import(`/src/${name}`);",
  })) {
    // A computed target can be any file, so the changed module has no edge to the loader. Every test
    // that runs the loader is selected instead of a full run; a test that never runs it is not.
    it(`selects the tests that run a ${name} when the changed target has no static edge`, async () => {
      const root = createTempRepo({
        "src/changed.ts": "export const value = 1;",
        "src/other.ts": "export const value = 2;",
        "src/loader.ts": source,
        "tests/loader.test.ts": "import { load } from '../src/loader'; export const value = load('changed');",
        "tests/unrelated.test.ts": "export const unrelated = 1;",
      });
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.equal(result.confidence, "UNSAFE");
        assert.ok(result.unresolved.some(ref => ref.importer === "src/loader.ts" && ref.dynamic && ref.computed));
        assert.notEqual(refineConfidenceForDelta(result, ["src/changed.ts"]), "UNSAFE");
        const impact = new ImpactAnalyzer().analyze({
          baseSha: "base", headSha: "head", files: [{ path: "src/changed.ts", changeType: "modified" }], directories: [],
          summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
          analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
        }, result, result.profile);
        assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
        const selected = impact.affectedTests.map(test => test.path);
        assert.ok(selected.includes("tests/loader.test.ts"), JSON.stringify(selected));
        assert.ok(!selected.includes("tests/unrelated.test.ts"), JSON.stringify(selected));
        assert.ok(impact.evidence.some(item => item.reason === "COMPUTED_IMPORT" && item.changedFile === "src/loader.ts"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const [name, source] of Object.entries({
    import: "export const load = () => import(`./changed`);",
    require: "export const load = () => require(`./changed`);",
  })) {
    it(`resolves no-substitution template ${name} as a literal dependency`, async () => {
      const root = createTempRepo({
        "src/changed.ts": "export const value = 1;",
        "src/loader.ts": source,
        "tests/loader.test.ts": "import { load } from '../src/loader'; export const value = load();",
        "tests/unrelated.test.ts": "export const unrelated = 1;",
      });
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.equal(result.confidence, "COMPLETE");
        assert.deepEqual(result.graph.transitiveDependentsOf("src/changed.ts"), ["src/loader.ts", "tests/loader.test.ts"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  const delta = (path: string) => ({
    baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" as const }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  });

  for (const [name, source] of Object.entries({
    import: "export const load = (name: string) => import(`./${name}`);",
    require: "export const load = (name: string) => require(`./${name}`);",
  })) {
    // The literal text bounds the target to src/, so every file there is a dependency (2026-11-03).
    it(`resolves an interpolated ${name} to every file its literal text allows`, async () => {
      const root = createTempRepo({
        "src/changed.ts": "export const value = 1;",
        "src/loader.ts": source,
        "lib/outside.ts": "export const value = 3;",
        "tests/loader.test.ts": "import { load } from '../src/loader'; export const value = load('changed');",
        "tests/unrelated.test.ts": "export const unrelated = 1;",
      });
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.equal(result.confidence, "COMPLETE", JSON.stringify(result.unresolved));
        assert.deepEqual(result.graph.dependenciesOf("src/loader.ts"), ["src/changed.ts"], "the importer itself and lib/ are not targets");
        assert.deepEqual(result.graph.transitiveDependentsOf("src/changed.ts"), ["src/loader.ts", "tests/loader.test.ts"]);
        assert.deepEqual(result.graph.transitiveDependentsOf("lib/outside.ts"), []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("resolves an aliased interpolated import of JSON files so a changed one selects its readers", async () => {
    const root = createTempRepo({
      "src/i18n.ts": "export const load = (lng: string, ns: string) => import(`@/../locales/${lng}/${ns}.json`);",
      "locales/en/auth.json": "{}",
      "locales/fr/auth.json": "{}",
      "tests/i18n.test.ts": "import { load } from '../src/i18n'; export const value = load('en', 'auth');",
      "tests/unrelated.test.ts": "export const unrelated = 1;",
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.deepEqual(result.graph.dependenciesOf("src/i18n.ts"), ["locales/en/auth.json", "locales/fr/auth.json"]);
      const impact = new ImpactAnalyzer().analyze(delta("locales/en/auth.json"), result, result.profile);
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.deepEqual(impact.affectedTests.map((test) => test.path), ["tests/i18n.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds an edge for every file an import.meta.glob matches, minus its negated patterns", async () => {
    const root = createTempRepo({
      "src/registry.ts": "export const modules = import.meta.glob(['./mods/*.ts', '!./mods/skip.ts']);",
      "src/mods/a.ts": "export const a = 1;",
      "src/mods/nested/b.ts": "export const b = 1;",
      "src/mods/skip.ts": "export const skip = 1;",
      "tests/registry.test.ts": "import { modules } from '../src/registry'; export const value = modules;",
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.confidence, "COMPLETE", JSON.stringify(result.unresolved));
      assert.deepEqual(result.graph.dependenciesOf("src/registry.ts"), ["src/mods/a.ts"], "* stays within one directory");
      assert.ok(result.graph.transitiveDependentsOf("src/mods/a.ts").includes("tests/registry.test.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [name, source] of Object.entries({
    "character class": "export const modules = import.meta.glob('./mods/[ab].ts');",
    "non-literal pattern": "const pattern = './mods/*.ts'; export const modules = import.meta.glob(pattern);",
    "pattern matching nothing": "export const modules = import.meta.glob('./missing/*.ts');",
  })) {
    it(`keeps an import.meta.glob with a ${name} computed`, async () => {
      const root = createTempRepo({ "src/registry.ts": source, "src/mods/a.ts": "export const a = 1;" });
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.ok(result.unresolved.some((ref) => ref.importer === "src/registry.ts" && ref.computed), JSON.stringify(result.unresolved));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  // 2026-11-06 LobeHub fixture replay: these kept their tests selected on every commit.
  for (const [name, source] of Object.entries({
    "concatenated literal": "export const load = () => import('./chan' + 'ged' + '.ts');",
    "const binding": "const modulePath = './changed' + '.ts'; export const load = async () => import(modulePath);",
    "cache-busting query": "export const load = () => import('./changed?v=' + Date.now());",
    "template over a const": "const dir = '.'; export const load = () => import(`${dir}/changed`);",
    // 2026-11-12 Paperclip: server/src/vendor/paperclip-runner/index.ts loads its source shim this way.
    "module-relative URL through a const": "const sourceUrl = new URL('./changed.ts', import.meta.url); export const load = () => import(sourceUrl.href);",
    "inline module-relative URL": "export const load = () => import(new URL('changed.ts', import.meta.url).href);",
    "module-relative URL toString": "const url = new URL('./changed.ts?v=1', import.meta.url); export const load = () => import(url.toString());",
  })) {
    it(`resolves a ${name} import to its one target`, async () => {
      const root = createTempRepo({
        "src/changed.ts": "export const value = 1;",
        "src/other.ts": "export const value = 2;",
        "src/loader.ts": source,
      });
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.equal(result.confidence, "COMPLETE", JSON.stringify(result.unresolved));
        assert.deepEqual(result.graph.dependenciesOf("src/loader.ts"), ["src/changed.ts"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const [name, source] of Object.entries({
    "const rebound in another scope": "const p = './changed'; export const load = (p: string) => import(p);",
    "numeric sum": "const a = 1; const b = 2; export const load = () => import(a + b);",
    "URL against another base": "const base = 'file:///x/'; const u = new URL('./changed.ts', base); export const load = () => import(u.href);",
    "absolute module URL": "export const load = () => import(new URL('/changed.ts', import.meta.url).href);",
    "URL rebound in another scope": "const u = new URL('./changed.ts', import.meta.url); export const load = (u: URL) => import(u.href);",
    "URL with an unknown head": "export const load = (name: string) => import(new URL(name, import.meta.url).href);",
  })) {
    it(`keeps a ${name} computed`, async () => {
      const root = createTempRepo({ "src/changed.ts": "export const value = 1;", "src/loader.ts": source });
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.ok(result.unresolved.some((ref) => ref.importer === "src/loader.ts" && ref.computed), JSON.stringify(result.unresolved));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("explains a repository-wide UNSAFE in counts, without paths", async () => {
    const root = createTempRepo({
      "src/changed.ts": "export const value = 1;",
      "src/loader.ts": "export const load = (name: string) => import(name);",
      "src/broken.ts": "import { x } from './missing'; export const y = x;",
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.confidence, "UNSAFE");
      const reasons = explainGraphConfidence(result);
      assert.deepEqual(reasons, [
        "1 computed module load in 1 file; the tests that run them are selected for every code change",
        "1 unresolved import; a change that reaches one falls back to full validation",
      ]);
      assert.ok(!reasons.join(" ").includes("src/"), "no paths");
      const clean = await buildDependencyGraph({ repoPath: createTempRepo({ "src/a.ts": "export const a = 1;" }) });
      assert.deepEqual(explainGraphConfidence(clean), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a root-absolute import.meta.glob from the Vite root", async () => {
    const root = createTempRepo({
      "vitest.config.mts": "export default {};",
      "src/locale.ts": "export const loaders = import.meta.glob(['/locales/*/*.json', '!/locales/*/skip.json']);",
      "locales/en/ui.json": "{}",
      "locales/en/skip.json": "{}",
      "tests/locale.test.ts": "import { loaders } from '../src/locale'; export const value = loaders;",
      "tests/unrelated.test.ts": "export const unrelated = 1;",
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.ok(!result.unresolved.some((ref) => ref.importer === "src/locale.ts"), JSON.stringify(result.unresolved));
      assert.deepEqual(result.graph.dependenciesOf("src/locale.ts"), ["locales/en/ui.json"]);
      const impact = new ImpactAnalyzer().analyze(delta("locales/en/ui.json"), result, result.profile);
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.deepEqual(impact.affectedTests.map((test) => test.path), ["tests/locale.test.ts"]);
      const unrelated = new ImpactAnalyzer().analyze(delta("src/other.ts"), result, result.profile);
      assert.ok(!unrelated.affectedTests.some((test) => test.path === "tests/locale.test.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runtime test selection", () => {
  const vitestRepo = (extra: FixtureFiles = {}) => createTempRepo({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0" } }),
    "vitest.config.ts": "export default { test: { include: ['tests/**/*.test.ts', 'tests/**/*.test-d.ts'] } };",
    "src/types.ts": "export interface Shape { size: number }\nexport const unit = 1;\n",
    "tests/runtime.test.ts": "import { unit } from '../src/types'; export const value = unit;",
    "tests/typed.test.ts": "import type { Shape } from '../src/types'; export const shape: Shape = { size: 1 };",
    "tests/shape.test-d.ts": "import type { Shape } from '../src/types'; export type Size = Shape['size'];",
    ...extra,
  });
  const changed = (path: string) => ({
    baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" as const }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  });

  it("does not select a Vitest test that only imports types from the changed file, but keeps type tests", async () => {
    const root = vitestRepo();
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.runtimeTestSelection, true);
      const selected = new ImpactAnalyzer().analyze(changed("src/types.ts"), result, result.profile).affectedTests.map((test) => test.path);
      assert.ok(selected.includes("tests/runtime.test.ts"), JSON.stringify(selected));
      assert.ok(selected.includes("tests/shape.test-d.ts"), JSON.stringify(selected));
      assert.ok(!selected.includes("tests/typed.test.ts"), JSON.stringify(selected));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // tsd and tstyche type-check only their own files (2026-11-10): the rest of a Vitest suite keeps runtime
  // selection, and their files keep every type edge.
  it("keeps runtime selection beside tsd, whose *.test-d.ts files still follow type edges", async () => {
    const root = vitestRepo({ "packages/legacy/package.json": JSON.stringify({ name: "legacy", scripts: { test: "tsd" } }) });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.runtimeTestSelection, true);
      const selected = new ImpactAnalyzer().analyze(changed("src/types.ts"), result, result.profile).affectedTests.map((test) => test.path);
      assert.ok(selected.includes("tests/shape.test-d.ts"), JSON.stringify(selected));
      assert.ok(!selected.includes("tests/typed.test.ts"), JSON.stringify(selected));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("confines Jest in a sub-package to that package's tests", async () => {
    // payloadcms/payload: .github/actions/triage has its own jest.config.js, packages/payload-cloud a `jest` script.
    const root = vitestRepo({
      ".github/actions/triage/jest.config.js": "module.exports = {};",
      "packages/legacy/package.json": JSON.stringify({ name: "legacy", scripts: { test: "jest" } }),
      "packages/legacy/tests/legacy.test.ts": "import type { Shape } from '../../../src/types'; export const shape: Shape = { size: 1 };",
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.runtimeTestSelection, true);
      assert.deepEqual(result.typeTestGlobs, [".github/actions/triage/**", "packages/legacy/**"]);
      const selected = new ImpactAnalyzer().analyze(changed("src/types.ts"), result, result.profile).affectedTests.map((test) => test.path);
      assert.ok(!selected.includes("tests/typed.test.ts"), JSON.stringify(selected));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats the files tstyche's testFileMatch names as type tests", async () => {
    const root = vitestRepo({
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "vitest run", "test:types": "tstyche" }, devDependencies: { vitest: "^3.0.0", tstyche: "^4.0.0" } }),
      "tstyche.json": JSON.stringify({ testFileMatch: ["tests/typed.test.ts"] }),
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.runtimeTestSelection, true);
      assert.deepEqual(result.typeTestGlobs, ["tests/typed.test.ts"]);
      const selected = new ImpactAnalyzer().analyze(changed("src/types.ts"), result, result.profile).affectedTests.map((test) => test.path);
      assert.ok(selected.includes("tests/typed.test.ts"), JSON.stringify(selected));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [name, extra] of Object.entries<FixtureFiles>({
    "a root Jest config": { "jest.config.js": "module.exports = {};" },
    "ts-jest at the root": { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0", "ts-jest": "^29.0.0" } }) },
    "Vitest typecheck mode": { "vitest.config.ts": "export default { test: { typecheck: { enabled: true } } };" },
  })) {
    it(`keeps type-only edges selecting tests when the repository has ${name}`, async () => {
      const root = vitestRepo(extra);
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.equal(result.runtimeTestSelection, false);
        const selected = new ImpactAnalyzer().analyze(changed("src/types.ts"), result, result.profile).affectedTests.map((test) => test.path);
        assert.ok(selected.includes("tests/typed.test.ts"), JSON.stringify(selected));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("narrows an unresolved type import in a test that already depends on the changed file", async () => {
    const root = vitestRepo({ "tests/runtime.test.ts": "import { unit } from '../src/types';\nimport type { Missing } from './action';\nexport const value: Missing | number = unit;" });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.confidence, "UNSAFE");
      assert.notEqual(refineConfidenceForDelta(result, ["src/types.ts"]), "UNSAFE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps UNSAFE for a runtime unresolved import in a file that reaches the change only through types", async () => {
    const root = vitestRepo({ "tests/typed.test.ts": "import type { Shape } from '../src/types';\nimport { missing } from './missing';\nexport const shape: Shape = { size: missing };" });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.equal(result.runtimeTestSelection, true);
      assert.equal(refineConfidenceForDelta(result, ["src/types.ts"]), "UNSAFE", "the test is not selected, so its missing edge could hide a dependency on the change");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("TypeScript import-equals dependencies", () => {
  for (const typeOnly of [false, true]) {
    it(`tracks ${typeOnly ? 'type-only' : 'runtime'} external-module import-equals declarations`, async () => {
      const root = createTempRepo({
        "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "CommonJS", moduleResolution: "Node10" }, include: ["**/*.ts"] }),
        "src/changed.ts": "const value = 1; export = value;",
        "src/loader.ts": `import ${typeOnly ? 'type ' : ''}changed = require('./changed'); export ${typeOnly ? 'type Value = typeof changed' : 'const value = changed'};`,
        "tests/loader.test.ts": "import './loader-helper';",
        "tests/loader-helper.ts": "import '../src/loader';",
        "tests/unrelated.test.ts": "export const unrelated = 1;",
      });
      try {
        const result = await buildDependencyGraph({ repoPath: root });
        assert.equal(result.confidence, "COMPLETE");
        assert.ok(result.graph.edges.some(edge => edge.from === "src/loader.ts" && edge.to === "src/changed.ts" && edge.kind === (typeOnly ? "type-import" : "require")));
        assert.ok(result.graph.transitiveDependentsOf("src/changed.ts").includes("tests/loader.test.ts"));
        assert.ok(!result.graph.transitiveDependentsOf("src/changed.ts").includes("tests/unrelated.test.ts"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
