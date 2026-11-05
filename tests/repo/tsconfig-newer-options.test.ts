// SPDX-License-Identifier: MIT
/**
 * TypeScript 6 option values in importer tsconfig files.
 *
 * Core bundles TypeScript 5.9, which rejects `"target": "es2025"` and `"lib": ["es2025"]` (valid in
 * TypeScript 6) with diagnostic 6046. The first GitLab run of the observer (2026-11-05) on an import
 * of jshttp/cookie came back FULL on every plan for that reason alone. The fixture below is that
 * repository's shape: a package-provided base config that a source clone does not have installed,
 * and local `module`/`target`/`lib` overrides.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import type { GitDelta } from "../../src/git/types.js";

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function cookieShapedRepo(compilerOptions: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-ts6-config-"));
  write(root, "package.json", JSON.stringify({ name: "cookie-shaped", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8", "@borderless/ts-scripts": "0.15.0" } }));
  write(root, "vitest.config.ts", "export default { test: { include: ['src/**/*.spec.ts'] } };");
  write(root, "tsconfig.json", JSON.stringify({ extends: "@borderless/ts-scripts/configs/tsconfig.json", compilerOptions, include: ["src/**/*"] }));
  write(root, "src/parse.ts", "export const parse = (s: string) => s;");
  write(root, "src/serialize.ts", "export const serialize = (s: string) => s;");
  write(root, "src/parse.spec.ts", "import { it } from 'vitest'; import { parse } from './parse.js'; it('parses', () => { parse('a'); });");
  write(root, "src/serialize.spec.ts", "import { it } from 'vitest'; import { serialize } from './serialize.js'; it('serializes', () => { serialize('a'); });");
  return root;
}

function delta(path: string): GitDelta {
  return {
    baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  };
}

const invalidImporter = (blockers: readonly string[] | undefined) => (blockers ?? []).some(reason => reason.includes("Invalid importer"));

describe("TypeScript 6 option values in importer tsconfig files", () => {
  it("plans selectively for an es2025 target and lib", async () => {
    const root = cookieShapedRepo({ module: "nodenext", target: "es2025", lib: ["es2025"], outDir: "dist", rootDir: "src", types: ["node"] });
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.ok(!invalidImporter(graph.adapterBlockers), JSON.stringify(graph.adapterBlockers));
      assert.notEqual(graph.confidence, "UNSAFE");
      assert.deepEqual(graph.graph.dependenciesOf("src/parse.spec.ts"), ["src/parse.ts"]);

      const change = delta("src/parse.ts");
      const impact = new ImpactAnalyzer().analyze(change, graph, graph.profile);
      const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta: change, impact, profile: graph.profile });
      assert.equal(plan.mode, "SELECTIVE");
      assert.deepEqual(plan.selectedTests, ["src/parse.spec.ts"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("stays fatal when an unknown target could change the default module resolution", async () => {
    const root = cookieShapedRepo({ target: "es2025", lib: ["es2025"] });
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.ok(invalidImporter(graph.adapterBlockers));
      assert.equal(graph.confidence, "UNSAFE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("stays fatal for an unknown moduleResolution value", async () => {
    const root = cookieShapedRepo({ module: "nodenext", moduleResolution: "nodenext2", target: "es2025" });
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.ok(invalidImporter(graph.adapterBlockers));
      assert.equal(graph.confidence, "UNSAFE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
