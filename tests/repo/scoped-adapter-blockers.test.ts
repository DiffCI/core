// SPDX-License-Identifier: MIT
/**
 * Framework blockers confined to nested package directories.
 *
 * Sentry's JavaScript SDK (2026-11-08, PR 26192) keeps about 200 E2E test applications under
 * dev-packages/e2e-tests/test-applications. 19 of them are Nuxt, SvelteKit or Vue apps whose tsconfig
 * extends a generated `.nuxt/` or `.svelte-kit/` file that a clean checkout does not have. Each was a
 * global blocker, so a three-file fix in packages/server-utils planned FULL. The fixture is that shape:
 * a pnpm workspace with an SDK package and a non-workspace Nuxt app inside the E2E package.
 *
 * The same checkout was not installed, so `@sentry/server-utils` imports by name resolved as external
 * packages and every edge into server-utils was missing. Those imports must fall back, not skip.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { buildDependencyGraph, refineConfidenceForDelta } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import type { GitDelta } from "../../src/git/types.js";

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const APP = "dev-packages/e2e-tests/test-applications/nuxt-app";

function sdkRepo(options: { nuxtConfig?: string; consumer?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-scoped-blockers-"));
  write(root, "package.json", JSON.stringify({ name: "sdk-monorepo", private: true, scripts: { test: "pnpm -r test" }, devDependencies: { vitest: "4.1.8", typescript: "5.9.3" } }));
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - 'dev-packages/e2e-tests'\n");
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", target: "es2022", strict: true }, include: ["packages", "dev-packages"] }));

  write(root, "packages/utils/package.json", JSON.stringify({ name: "@sdk/utils", version: "1.0.0", scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
  write(root, "packages/utils/src/bedrock.ts", "export const bedrock = () => 'bedrock';");
  write(root, "packages/utils/src/other.ts", "export const other = () => 'other';");
  write(root, "packages/utils/test/bedrock.test.ts", "import { it } from 'vitest'; import { bedrock } from '../src/bedrock'; it('works', () => { bedrock(); });");
  write(root, "packages/utils/test/other.test.ts", "import { it } from 'vitest'; import { other } from '../src/other'; it('works', () => { other(); });");

  if (options.consumer) {
    write(root, "packages/node/package.json", JSON.stringify({ name: "@sdk/node", version: "1.0.0", scripts: { test: "vitest run" }, dependencies: { "@sdk/utils": "workspace:*" }, devDependencies: { vitest: "4.1.8" } }));
    write(root, "packages/node/src/index.ts", "import { bedrock } from '@sdk/utils'; export const init = () => bedrock();");
    write(root, "packages/node/test/index.test.ts", "import { it } from 'vitest'; import { init } from '../src/index'; it('works', () => { init(); });");
  }

  write(root, "dev-packages/e2e-tests/package.json", JSON.stringify({ name: "@sdk-internal/e2e-tests", private: true, scripts: { "test:e2e": "node run.mjs" } }));
  write(root, "dev-packages/e2e-tests/run.mjs", "console.log('run');");
  write(root, `${APP}/package.json`, JSON.stringify({ name: "nuxt-app", private: true, dependencies: { nuxt: "4.0.0" }, devDependencies: { "@playwright/test": "1.50.0" } }));
  write(root, `${APP}/tsconfig.json`, JSON.stringify({ extends: "./.nuxt/tsconfig.json" }));
  write(root, `${APP}/nuxt.config.ts`, options.nuxtConfig ?? "export default defineNuxtConfig({ modules: [] });");
  write(root, `${APP}/app.vue`, "<template><div><NuxtPage /></div></template>\n");
  write(root, `${APP}/composables/useThing.ts`, "export const useThing = () => 1;");
  write(root, `${APP}/tests/home.test.ts`, "import { test } from '@playwright/test'; test('home', async () => {});");
  return root;
}

function delta(path: string): GitDelta {
  return {
    baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  };
}

async function planFor(root: string, path: string) {
  const graph = await buildDependencyGraph({ repoPath: root });
  const change = delta(path);
  const impact = new ImpactAnalyzer().analyze(change, graph, graph.profile);
  const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta: change, impact, profile: graph.profile });
  return { graph, impact, plan };
}

describe("framework blockers confined to nested package directories", () => {
  it("does not let a nested Nuxt app with a generated tsconfig decide an SDK package change", async () => {
    const root = sdkRepo();
    try {
      const { graph, impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      // The graph itself is still UNSAFE: only a delta can rule the app out.
      assert.equal(graph.confidence, "UNSAFE");
      assert.ok(!(graph.adapterBlockers ?? []).some((reason) => reason.includes("Invalid importer") || reason.startsWith("Nuxt")), JSON.stringify(graph.adapterBlockers));
      const scoped = graph.scopedAdapterBlockers ?? [];
      assert.ok(scoped.some((b) => b.reason === `Invalid importer TypeScript configuration: ${APP}/tsconfig.json` && b.directories.includes(APP)), JSON.stringify(scoped));
      assert.ok(scoped.some((b) => b.reason.startsWith("Nuxt implicit routes") && b.directories.includes(APP)), JSON.stringify(scoped));
      assert.notEqual(impact.effectiveGraphConfidence, "UNSAFE");
      assert.deepEqual(impact.fallbackReasons, []);
      assert.equal(plan.mode, "SELECTIVE");
      assert.ok(plan.selectedTests.includes("packages/utils/test/bedrock.test.ts"));
      assert.ok(!plan.selectedTests.includes("packages/utils/test/other.test.ts"), JSON.stringify(plan.selectedTests));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("falls back for a change inside the nested app", async () => {
    const root = sdkRepo();
    try {
      const { impact, plan } = await planFor(root, `${APP}/composables/useThing.ts`);
      assert.equal(impact.effectiveGraphConfidence, "UNSAFE");
      assert.ok(impact.fallbackReasons.includes(`Invalid importer TypeScript configuration: ${APP}/tsconfig.json`), JSON.stringify(impact.fallbackReasons));
      assert.equal(plan.mode, "FULL");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the Nuxt blocker global when the app's config reaches other directories", async () => {
    const root = sdkRepo({ nuxtConfig: "export default defineNuxtConfig({ extends: ['../shared-layer'] });" });
    try {
      const { graph, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok((graph.adapterBlockers ?? []).includes("Nuxt implicit routes and auto-imports require a dedicated framework adapter"), JSON.stringify(graph.adapterBlockers));
      assert.equal(refineConfidenceForDelta(graph, ["packages/utils/src/bedrock.ts"]), "UNSAFE");
      assert.equal(plan.mode, "FULL");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps an invalid app tsconfig global when its aliases point outside the app", async () => {
    const root = sdkRepo();
    try {
      write(root, `${APP}/tsconfig.json`, JSON.stringify({ extends: "./.nuxt/tsconfig.json", compilerOptions: { paths: { "@utils/*": ["../../../../packages/utils/src/*"] } } }));
      const { graph, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok((graph.adapterBlockers ?? []).includes(`Invalid importer TypeScript configuration: ${APP}/tsconfig.json`), JSON.stringify(graph.adapterBlockers));
      assert.equal(plan.mode, "FULL");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("confines unmodeled-language files in a top-level dot-directory to that directory", async () => {
    const root = sdkRepo();
    try {
      write(root, ".agents/skills/creator/scripts/run.py", "print('skill')\n");
      const { graph, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      const reason = "Unmodeled languages alongside an adapter require full validation";
      assert.ok(!(graph.adapterBlockers ?? []).includes(reason), JSON.stringify(graph.adapterBlockers));
      assert.deepEqual(graph.scopedAdapterBlockers?.find((b) => b.reason === reason)?.directories, [".agents"]);
      assert.equal(plan.mode, "SELECTIVE");
      write(root, "scripts/run.py", "print('root tooling')\n");
      const again = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok((again.graph.adapterBlockers ?? []).includes(reason), JSON.stringify(again.graph.adapterBlockers));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("falls back when a changed workspace package is imported by name but not installed", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      const { graph, impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      const reason = "Workspace package @sdk/utils is imported by 1 file but does not resolve to its repository sources; install and link dependencies before analysis";
      assert.ok((graph.scopedAdapterBlockers ?? []).some((b) => b.reason === reason && b.directories.join() === "packages/utils"), JSON.stringify(graph.scopedAdapterBlockers));
      assert.ok(impact.fallbackReasons.includes(reason), JSON.stringify(impact.fallbackReasons));
      assert.equal(plan.mode, "FULL");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still narrows a change the uninstalled workspace import cannot reach", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      const { impact, plan } = await planFor(root, "packages/node/src/index.ts");
      assert.deepEqual(impact.fallbackReasons, []);
      assert.equal(plan.mode, "SELECTIVE");
      assert.deepEqual(plan.selectedTests, ["packages/node/test/index.test.ts"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed for a cached result that has scoped blockers but no unscoped confidence", async () => {
    const root = sdkRepo();
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      const { confidenceWithoutScopedBlockers: _dropped, ...older } = graph;
      assert.equal(refineConfidenceForDelta(older, ["packages/utils/src/bedrock.ts"]), "UNSAFE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
