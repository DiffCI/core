// SPDX-License-Identifier: MIT
// Path-literal edges and the computedImports opt-in (2026-11-10, payloadcms/payload): integration tests pass
// `{ config: './config.ts' }` to a helper that `import()`s it.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { GitDelta } from "../../src/git/types.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-path-literals-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function delta(path: string): GitDelta {
  return {
    baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  };
}

const fixture = (extra: Record<string, string> = {}) => ({
  "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0" } }),
  "vitest.config.ts": "export default { test: { include: ['test/**/*.spec.ts'] } };",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["src", "test"] }),
  "src/plugin-a.ts": "export const pluginA = 1;\n",
  "src/plugin-b.ts": "export const pluginB = 2;\n",
  "src/other.ts": "export const other = 3;\n",
  // A loader like Payload's test helper: the path comes from the caller, so the load is computed.
  "test/helper.ts": "export async function suite(configPath: string) {\n  return import(configPath);\n}\n",
  "test/a/config.ts": "import { pluginA } from '../../src/plugin-a.js';\nexport default { plugins: [pluginA] };\n",
  "test/b/config.ts": "import { pluginB } from '../../src/plugin-b.js';\nexport default { plugins: [pluginB] };\n",
  "test/a/int.spec.ts": "import { suite } from '../helper.js';\nawait suite(new URL('./config.ts', import.meta.url).pathname);\n",
  "test/b/int.spec.ts": "import { suite } from '../helper.js';\nawait suite(new URL('./config.ts', import.meta.url).pathname);\n",
  "test/plain.spec.ts": "import { other } from '../src/other.js';\nexport const value = other;\n",
  ...extra,
});

async function selected(files: Record<string, string>, changed: string) {
  const root = repo(files);
  try {
    const graph = await buildDependencyGraph({ repoPath: root, excludeDirs: ["node_modules"] });
    const impact = new ImpactAnalyzer().analyze(delta(changed), graph, graph.profile);
    return { graph, impact, tests: impact.affectedTests.map((test) => test.path).sort() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("path-literal edges", () => {
  it("makes a test depend on the code file a string in it names", async () => {
    const { graph } = await selected(fixture(), "src/plugin-a.ts");
    assert.ok(graph.graph.dependenciesOf("test/a/int.spec.ts").includes("test/a/config.ts"), JSON.stringify(graph.graph.dependenciesOf("test/a/int.spec.ts")));
    assert.ok(graph.graph.edges.some((edge) => edge.from === "test/a/int.spec.ts" && edge.to === "test/a/config.ts" && edge.kind === "path-literal"));
  });
  it("does not turn import specifiers into path-literal edges", async () => {
    const { graph } = await selected(fixture(), "src/plugin-a.ts");
    assert.ok(!graph.graph.edges.some((edge) => edge.kind === "path-literal" && edge.to.endsWith("helper.ts")));
    assert.ok(!graph.graph.edges.some((edge) => edge.kind === "path-literal" && edge.to.startsWith("src/")));
  });
  it("ignores a string naming a file that does not exist", async () => {
    const { graph, impact } = await selected(fixture({ "test/missing.spec.ts": "export const p = './not-there.ts';\n" }), "src/other.ts");
    assert.ok(!graph.graph.edges.some((edge) => edge.from === "test/missing.spec.ts"));
    assert.ok(!(graph.adapterBlockers ?? []).some((blocker) => blocker.includes("not-there")));
    assert.ok(!impact.fallbackReasons.some((reason) => reason.includes("not-there")), JSON.stringify(impact.fallbackReasons));
  });
});

describe("computedImports: follow-path-literals", () => {
  it("by default, selects every test that runs the computed load", async () => {
    const { tests } = await selected(fixture(), "src/plugin-a.ts");
    assert.deepEqual(tests, ["test/a/int.spec.ts", "test/b/int.spec.ts"]);
  });
  it("when declared, selects only the tests whose named files reach the change", async () => {
    const { tests, impact } = await selected(fixture({ "diffci.json": JSON.stringify({ computedImports: "follow-path-literals" }) }), "src/plugin-a.ts");
    assert.deepEqual(tests, ["test/a/int.spec.ts"]);
    assert.ok(impact.evidence.some((e) => e.message.includes("computedImports: follow-path-literals")));
  });
  it("still selects nothing extra for an unrelated change when declared", async () => {
    const { tests } = await selected(fixture({ "diffci.json": JSON.stringify({ computedImports: "follow-path-literals" }) }), "src/other.ts");
    assert.deepEqual(tests, ["test/plain.spec.ts"]);
  });
  it("treats any other value as a configuration error", async () => {
    const { impact } = await selected(fixture({ "diffci.json": JSON.stringify({ computedImports: "trust-me" }) }), "src/plugin-a.ts");
    assert.ok(impact.fallbackRequired, JSON.stringify(impact.fallbackReasons));
  });
});
