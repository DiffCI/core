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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Sentry's package shape: `types` and `exports` point at build/, and tsconfig.types.json maps build/types
 * back to src. `nested` puts `types` under `import`/`require`, as `@sentry-internal/test-utils` does. */
function buildOutputManifest(root: string, shape: "flat" | "nested"): void {
  const types = "./build/types/index.d.ts";
  const exports = shape === "flat"
    ? { "./package.json": "./package.json", ".": { types, import: "./build/esm/index.js", require: "./build/cjs/index.js" } }
    : { ".": { import: { types, default: "./build/esm/index.js" }, require: { types, default: "./build/cjs/index.js" } } };
  write(root, "packages/utils/package.json", JSON.stringify({ name: "@sdk/utils", version: "1.0.0", main: "build/cjs/index.js", module: "build/esm/index.js", types: "build/types/index.d.ts", exports, scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
  write(root, "packages/utils/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json", include: ["src/**/*"] }));
  write(root, "packages/utils/tsconfig.types.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { declaration: true, emitDeclarationOnly: true, outDir: "build/types", rootDir: "./src" } }));
  write(root, "packages/utils/src/index.ts", "export { bedrock } from './bedrock';\nexport { other } from './other';\n");
}

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
      const reason = "Workspace package @sdk/utils is imported by 1 file but DiffCI cannot map the import to the package's source files; point the package's types entry at a tsconfig outDir or declarationDir with a rootDir, or at source";
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

  for (const shape of ["flat", "nested"] as const) {
    it(`maps an unbuilt workspace package's build/types entry to its source (${shape} exports)`, async () => {
      const root = sdkRepo({ consumer: true });
      try {
        buildOutputManifest(root, shape);
        const { impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
        assert.deepEqual(impact.fallbackReasons, []);
        assert.equal(plan.mode, "SELECTIVE");
        assert.ok(plan.selectedTests.includes("packages/node/test/index.test.ts"), JSON.stringify(plan.selectedTests));
        assert.ok(plan.selectedTests.includes("packages/utils/test/bedrock.test.ts"));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it("follows a built and linked workspace package to its source, not to its generated declarations", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      buildOutputManifest(root, "flat");
      // What `pnpm install` and `build:types` leave behind: a workspace link and generated declarations.
      write(root, "packages/utils/build/types/index.d.ts", "export { bedrock } from './bedrock';\nexport { other } from './other';\n");
      write(root, "packages/utils/build/types/bedrock.d.ts", "export declare const bedrock: () => string;\n");
      write(root, "packages/utils/build/types/other.d.ts", "export declare const other: () => string;\n");
      mkdirSync(join(root, "packages/node/node_modules/@sdk"), { recursive: true });
      symlinkSync(join(root, "packages/utils"), join(root, "packages/node/node_modules/@sdk/utils"), "junction");
      const { graph, impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok(graph.graph.dependenciesOf("packages/node/src/index.ts").includes("packages/utils/src/index.ts"), JSON.stringify(graph.graph.dependenciesOf("packages/node/src/index.ts")));
      assert.ok(!graph.graph.nodes.some((node) => node.path.includes("/build/")), "no edge may end in build output");
      assert.deepEqual(impact.fallbackReasons, []);
      assert.ok(plan.selectedTests.includes("packages/node/test/index.test.ts"), JSON.stringify(plan.selectedTests));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("maps a JavaScript-only export through a tsconfig outDir, and a deep import of a declaration path", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      buildOutputManifest(root, "flat");
      // Sentry's @sentry/deno: `./import` exports only build/import.mjs, and tsconfig.build.json states outDir build.
      const manifest = JSON.parse(readFileSync(join(root, "packages/utils/package.json"), "utf8"));
      manifest.exports["./import"] = { import: "./build/import.mjs" };
      write(root, "packages/utils/package.json", JSON.stringify(manifest));
      write(root, "packages/utils/tsconfig.build.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "build", rootDir: "./src", allowJs: true } }));
      write(root, "packages/utils/src/import.mjs", "export const hook = 1;\n");
      write(root, "packages/node/src/hook.ts", "import { hook } from '@sdk/utils/import'; export const h = hook;");
      write(root, "packages/node/src/types.ts", "import type { bedrock } from '@sdk/utils/build/types/bedrock'; export type B = typeof bedrock;");
      const { graph } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.deepEqual(graph.graph.dependenciesOf("packages/node/src/types.ts"), ["packages/utils/src/bedrock.ts"]);
      const hookRef = graph.references.find((ref) => ref.importer === "packages/node/src/hook.ts");
      assert.equal(hookRef?.resolution, "internal-source", JSON.stringify(hookRef));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("maps a `.js` export entry to the TypeScript source beside it", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      // payloadcms/payload: `"types": "./src/exports/build-config.js"` names src/exports/build-config.ts.
      write(root, "packages/utils/package.json", JSON.stringify({ name: "@sdk/utils", version: "1.0.0", main: "./src/index.ts",
        exports: { ".": { types: "./src/index.js", import: "./src/index.js" }, "./config": { types: "./src/config.js", default: "./src/config.js" } },
        scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
      write(root, "packages/utils/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { outDir: "dist", rootDir: "./src" }, include: ["src/**/*"] }));
      write(root, "packages/utils/src/index.ts", "export { bedrock } from './bedrock';\nexport { other } from './other';\n");
      write(root, "packages/utils/src/config.ts", "export const config = 1;\n");
      write(root, "packages/node/src/config.ts", "import { config } from '@sdk/utils/config'; export const c = config;");
      const { graph, impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.deepEqual(impact.fallbackReasons, []);
      assert.deepEqual(graph.graph.dependenciesOf("packages/node/src/config.ts"), ["packages/utils/src/config.ts"]);
      assert.ok(plan.selectedTests.includes("packages/node/test/index.test.ts"), JSON.stringify(plan.selectedTests));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("follows a workspace import into a package no tsconfig lists", async () => {
    // The long path: on Windows tmpdir() can be an 8.3 short name that TypeScript's resolved paths do not use.
    const root = realpathSync.native(sdkRepo({ consumer: true }));
    try {
      // payloadcms/payload: the root tsconfig references some packages; the rest are reached only by import.
      write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", target: "es2022", strict: true }, include: ["packages/node"] }));
      write(root, "packages/utils/package.json", JSON.stringify({ name: "@sdk/utils", version: "1.0.0", exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } }, scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
      write(root, "packages/utils/src/index.ts", "export { bedrock } from './bedrock';\nexport { other } from './other';\n");
      // What `pnpm install` leaves: TypeScript resolves the import through the link into packages/utils/src.
      mkdirSync(join(root, "packages/node/node_modules/@sdk"), { recursive: true });
      symlinkSync(join(root, "packages/utils"), join(root, "packages/node/node_modules/@sdk/utils"), "junction");
      const { graph, impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.deepEqual(impact.fallbackReasons, []);
      assert.ok(graph.graph.dependenciesOf("packages/node/src/index.ts").includes("packages/utils/src/index.ts"), JSON.stringify(graph.graph.dependenciesOf("packages/node/src/index.ts")));
      assert.ok(plan.selectedTests.includes("packages/node/test/index.test.ts"), JSON.stringify(plan.selectedTests));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("maps a stylesheet export to an asset, and ignores a type import of a subpath the package does not have", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      buildOutputManifest(root, "flat");
      // payloadcms/payload: `@payloadcms/ui/css/app.css`, and a stale `import type ... from 'payload/types'`.
      const manifest = JSON.parse(readFileSync(join(root, "packages/utils/package.json"), "utf8"));
      manifest.exports["./css/app.css"] = "./src/css/app.css";
      write(root, "packages/utils/package.json", JSON.stringify(manifest));
      write(root, "packages/utils/src/css/app.css", "body { margin: 0; }\n");
      write(root, "packages/node/src/layout.ts", "import '@sdk/utils/css/app.css';\nimport type { Missing } from '@sdk/utils/types';\nexport type M = Missing;\nexport const layout = 1;\n");
      const { graph, impact } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.deepEqual(impact.fallbackReasons, []);
      assert.ok(graph.graph.dependenciesOf("packages/node/src/layout.ts").includes("packages/utils/src/css/app.css"), JSON.stringify(graph.graph.dependenciesOf("packages/node/src/layout.ts")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not let a fixture only path strings name block every change to the package it imports", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      buildOutputManifest(root, "flat");
      // payloadcms/payload's codemod tests read `./basic.input.ts` as text; it imports a removed subpath on purpose.
      write(root, "packages/node/test/codemod.test.ts", "import { it } from 'vitest'; import { readFileSync } from 'node:fs';\nit('migrates', () => readFileSync(new URL('./fixtures/basic.input.ts', import.meta.url), 'utf8'));\n");
      write(root, "packages/node/test/fixtures/basic.input.ts", "import { old } from '@sdk/utils/removed';\nexport const x = old;\n");
      // As in Payload, no tsconfig compiles the fixtures: only the path string reaches them.
      write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", target: "es2022", strict: true }, include: ["packages", "dev-packages"], exclude: ["**/fixtures/**"] }));
      const { graph, impact } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.deepEqual(impact.fallbackReasons, []);
      assert.ok(graph.unresolved.some((u) => u.importer === "packages/node/test/fixtures/basic.input.ts"), JSON.stringify(graph.unresolved));
      // A change to the fixture itself reaches its unmapped import and still falls back.
      const own = await planFor(root, "packages/node/test/fixtures/basic.input.ts");
      assert.ok(own.impact.fallbackRequired, JSON.stringify(own.impact.fallbackReasons));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still falls back for a runtime import of a workspace subpath it cannot map", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      buildOutputManifest(root, "flat");
      write(root, "packages/node/src/missing.ts", "import { x } from '@sdk/utils/missing';\nexport const m = x;\n");
      const { impact } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok(impact.fallbackReasons.some((reason) => reason.startsWith("Workspace package @sdk/utils is imported by 1 file")), JSON.stringify(impact.fallbackReasons));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("falls back when a change reaches a workspace package whose tests DiffCI cannot see", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      buildOutputManifest(root, "flat");
      // Sentry's node-integration-tests: `vitest run` on `./**/test.ts`, declared in a vite.config.ts.
      write(root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - 'dev-packages/e2e-tests'\n  - 'dev-packages/integration'\n");
      write(root, "dev-packages/integration/package.json", JSON.stringify({ name: "@sdk-internal/integration", private: true, scripts: { test: "vitest run" }, dependencies: { "@sdk/node": "workspace:*" }, devDependencies: { vitest: "4.1.8" } }));
      write(root, "dev-packages/integration/vite.config.ts", "import base from '../../vite.base'; export default { ...base, test: { ...base.test, include: ['./**/test.ts'] } };\n");
      write(root, "packages/node/package.json", JSON.stringify({ name: "@sdk/node", version: "1.0.0", types: "./src/index.ts", scripts: { test: "vitest run" }, dependencies: { "@sdk/utils": "workspace:*" }, devDependencies: { vitest: "4.1.8" } }));
      write(root, "dev-packages/integration/suites/bedrock/test.ts", "import { it } from 'vitest'; import { init } from '@sdk/node'; it('runs', () => { init(); });");
      const reason = "Workspace package dev-packages/integration declares vitest but no test files were discovered in it; full validation required";
      const reached = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok(reached.impact.fallbackReasons.includes(reason), JSON.stringify(reached.impact.fallbackReasons));
      assert.equal(reached.plan.mode, "FULL");
      write(root, "packages/utils/src/internal.ts", "export const internal = 1;");
      write(root, "packages/utils/test/internal.test.ts", "import { it } from 'vitest'; import { internal } from '../src/internal'; it('works', () => { internal; });");
      const elsewhere = await planFor(root, "packages/utils/src/internal.ts");
      assert.ok(!elsewhere.impact.fallbackReasons.includes(reason), JSON.stringify(elsewhere.impact.fallbackReasons));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("falls back when the types entry has no tsconfig mapping back to source", async () => {
    const root = sdkRepo({ consumer: true });
    try {
      buildOutputManifest(root, "flat");
      write(root, "packages/utils/tsconfig.types.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { declaration: true, emitDeclarationOnly: true, outDir: "build/types" } }));
      const { impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok(impact.fallbackReasons.some((reason) => reason.startsWith("Workspace package @sdk/utils is imported by 1 file but DiffCI cannot map")), JSON.stringify(impact.fallbackReasons));
      assert.equal(plan.mode, "FULL");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves imports from outside the workspace to the registry or tarball they install from", async () => {
    const root = sdkRepo();
    try {
      write(root, `${APP}/composables/useThing.ts`, "import { bedrock } from '@sdk/utils'; export const useThing = () => bedrock();");
      const { graph, impact, plan } = await planFor(root, "packages/utils/src/bedrock.ts");
      assert.ok(!(graph.scopedAdapterBlockers ?? []).some((b) => b.reason.startsWith("Workspace package")), JSON.stringify(graph.scopedAdapterBlockers));
      assert.deepEqual(impact.fallbackReasons, []);
      assert.equal(plan.mode, "SELECTIVE");
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
