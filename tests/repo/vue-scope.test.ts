import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import type { GitDelta } from "../../src/git/types.js";

const base = {
  "package.json": '{"private":true,"devDependencies":{"nuxt":"1"}}',
  "pnpm-lock.yaml": "lockfileVersion: 9",
  "diffci.json": JSON.stringify({ vue: { packageRoot: "packages/ui", testConfig: "vitest.config.ts" } }),
  "docs/Broken.vue": "<template><Unregistered /></template>",
  "nuxt.config.ts": "export default {}",
  "packages/ui/package.json": '{"devDependencies":{"vitest":"1","vue":"3"}}',
  "packages/ui/vitest.config.ts": 'import {defineConfig} from "vitest/config"; export default defineConfig({test:{include:["tests/**/*.test.ts"],setupFiles:"./setup.ts"}});',
  "packages/ui/setup.ts": 'import { shared } from "./shared"; export const setup = shared;',
  "packages/ui/shared.ts": "export const shared = 1;",
  "packages/ui/src/value.ts": "export const value = 1;",
  "packages/ui/src/Child.vue": '<script setup lang="ts">import {value} from "./value"</script><template>{{value}}</template>',
  "packages/ui/tests/child.test.ts": 'import Child from "../src/Child.vue"; export const child = Child;',
  "packages/ui/tests/other.test.ts": "export const other = 1;",
};
function fixture(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "diffci-vue-scope-"));
  for (const [path, text] of Object.entries({ ...base, ...extra })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
}
function delta(path: string): GitDelta {
  return { baseSha: "base", headSha: "head", files: [{ path, changeType: "modified" }], directories: [], summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 }, analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false } };
}

test("Vue root-relative include and exclude globs establish the actual scoped test inventory", async () => {
  const root = fixture({ "packages/ui/vitest.config.ts": 'import {defineConfig} from "vitest/config"; export default defineConfig({test:{include:["./**/*.test.{ts,js}"],exclude:["./tests/other.test.ts"]}});' });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    assert.deepEqual(result.profile.testFilePaths, ["packages/ui/tests/child.test.ts"]);
    const impact = new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), result, result.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map(test => test.path), ["packages/ui/tests/child.test.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue scoped blockers exclude unreachable examples but retain imported and setup-loaded components", async () => {
  const root = fixture({ "packages/ui/src/Unused.story.vue": "<template><Unregistered /></template>" });
  try {
    const isolated = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(isolated.adapterBlockers, []);
    assert.equal(isolated.performance.adapterMetrics?.vue.counts.outOfSuiteBlockers, 1);
    assert.equal(new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), isolated, isolated.profile).fallbackRequired, false);
    writeFileSync(join(root, "packages/ui/tests/other.test.ts"), 'import "../src/Unused.story.vue";');
    const imported = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(imported.adapterBlockers, []);
    assert.deepEqual(imported.profile.vueRuntimeAlwaysRunPaths, ["packages/ui/tests/other.test.ts"]);
    writeFileSync(join(root, "packages/ui/tests/other.test.ts"), 'export const other = 1;');
    writeFileSync(join(root, "packages/ui/setup.ts"), 'import "./src/Unused.story.vue";');
    assert.ok((await buildDependencyGraph({ repoPath: root })).adapterBlockers?.some(reason => reason.includes("Unused.story.vue")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Vue runtime uncertainty always runs importing tests for unrelated changes", async () => {
  const root = fixture({
    "packages/ui/src/Runtime.vue": '<script setup>defineProps(["component"])</script><template><component :is="component" /></template>',
    "packages/ui/tests/runtime.test.ts": 'import Runtime from "../src/Runtime.vue"; export const component = Runtime;',
  });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    assert.deepEqual(result.profile.vueRuntimeAlwaysRunPaths, ["packages/ui/tests/runtime.test.ts"]);
    const impact = new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), result, result.profile);
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
    assert.deepEqual(impact.affectedTests.map(t => t.path).sort(), ["packages/ui/tests/child.test.ts", "packages/ui/tests/runtime.test.ts"]);
    assert.ok(impact.affectedTests.find(t => t.path.endsWith("runtime.test.ts"))?.reasons.includes("ALWAYS_RUN_POLICY"));
    const rediscovered = { ...result.profile, vueRuntimeAlwaysRunPaths: undefined };
    const retained = new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), result, rediscovered);
    assert.ok(retained.affectedTests.some(t => t.path.endsWith("runtime.test.ts")), "graph protections survive a separately discovered caller profile");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vue runtime partition refuses disabled or unverified isolation and shared runtime roots", async () => {
  for (const options of ['isolate:false', 'isolate:enabled', 'poolOptions:{threads:{isolate:false}}', 'pool:"custom"', 'environment:"custom"', 'browser:{enabled:true}', 'runner:"./runner"']) {
    const root = fixture({
      "packages/ui/vitest.config.ts": `export default {test:{include:["tests/**/*.test.ts"],${options}}};`,
      "packages/ui/src/Child.vue": '<template><Unknown /></template>',
    });
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.ok(result.adapterBlockers?.some(reason => reason.includes("runtime component")), options);
      assert.equal(new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), result, result.profile).fallbackRequired, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const root = fixture({
    "packages/ui/vitest.config.ts": 'const shared={isolate:false}; export default {test:{include:["tests/**/*.test.ts"]},test:shared};',
    "packages/ui/src/Child.vue": '<template><Unknown /></template>',
  });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.ok(result.adapterBlockers?.length, "duplicate test keys cannot establish isolation from an overridden object");
    assert.notEqual(result.profile.vueRuntimeIsolationVerified, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Vue scope isolates unrelated docs, pins the runner cwd/config, and guards setup and outside changes", async () => {
  const root = fixture();
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    assert.deepEqual(result.profile.testFilePaths, ["packages/ui/tests/child.test.ts", "packages/ui/tests/other.test.ts"]);
    assert.ok(!result.graph.nodes.some(node => node.path.startsWith("docs/")));
    const impact = new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), result, result.profile);
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
    assert.deepEqual(impact.affectedTests.map(test => test.path), ["packages/ui/tests/child.test.ts"]);
    const plan = planSelectiveTestCommands(result.profile, impact.affectedTests.map(test => test.path));
    assert.deepEqual(plan.commands, [{ executable: "pnpm", args: ["--dir", "packages/ui", "exec", "vitest", "run", "--config", "vitest.config.ts", "tests/child.test.ts"] }]);
    assert.ok(planSelectiveTestCommands(result.profile, ["docs/unknown.test.ts"]).refusalReason);
    for (const path of ["docs/Broken.vue", "packages/ui/setup.ts", "packages/ui/shared.ts", "packages/ui/vitest.config.ts", "diffci.json"]) {
      assert.equal(new ImpactAnalyzer().analyze(delta(path), result, result.profile).fallbackRequired, true, path);
    }
    const renamed = delta("packages/ui/src/moved.ts"); renamed.files[0].oldPath = "outside.ts"; renamed.files[0].changeType = "renamed";
    assert.equal(new ImpactAnalyzer().analyze(renamed, result, result.profile).fallbackRequired, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Vue scope refuses crossing imports, missing/dynamic suites and invalid declarations", async () => {
  for (const extra of [
    { "packages/ui/src/value.ts": 'export { value } from "../../../shared";', "shared.ts": "export const value = 1;" },
    { "packages/ui/src/Child.vue": '<script setup>import Other from "../../../other.vue"</script><template><Other/></template>', "other.vue": "<template>other</template>" },
    { "packages/ui/vitest.config.ts": 'export default {test:{setupFiles:"../../outside.ts"}}', "outside.ts": "export {};" },
    { "packages/ui/vitest.config.ts": 'import auto from "unplugin-auto-import"; export default {plugins:[auto()]};' },
    { "packages/ui/vitest.config.ts": 'export default {root:"../other"};' },
    { "packages/ui/vitest.config.ts": 'export default {test:{include:["../../outside/*.test.ts"]}};' },
    { "packages/ui/vitest.config.ts": 'const shared={}; export default {...shared};' },
    { "packages/ui/src/value.ts": 'export { value } from "../build/generated";', "packages/ui/build/generated.ts": "export const value = (;" },
    { "packages/ui/src/value.ts": 'export { value } from "../build/generated";', "packages/ui/build/generated.ts": 'export {value} from "../../../shared";', "shared.ts": "export const value = 1;" },
    { "packages/ui/src/value.ts": '/// <reference path="./global.ts" />\nexport const value = 1;', "packages/ui/src/global.ts": "declare const globalValue: number;" },
    { "packages/ui/vitest.config.ts": 'export default {test:{typecheck:{enabled:true,include:["types/*.ts"]}}};' },
    { "diffci.json": JSON.stringify({ vue: { packageRoot: "../escape", testConfig: "vitest.config.ts" } }) },
    { "diffci.json": JSON.stringify({ vue: { packageRoot: "missing", testConfig: "vitest.config.ts" } }) },
  ] as Record<string, string>[]) {
    const root = fixture(extra);
    try {
      const result = await buildDependencyGraph({ repoPath: root });
      assert.ok(result.adapterBlockers?.length, JSON.stringify(extra));
      assert.equal(new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), result, result.profile).fallbackRequired, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test("Vue scoped selections retain every configured default type-test file", async () => {
  const root = fixture({
    "packages/ui/vitest.config.ts": 'export default {test:{include:["tests/**/*.test.ts"],typecheck:{enabled:true}}};',
    "packages/ui/types/public.test-d.ts": 'import { value } from "../src/value"; export type Value = typeof value;',
    "packages/ui/types/other.spec-d.ts": 'export type Other = string;',
  });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    const types = ["packages/ui/types/other.spec-d.ts", "packages/ui/types/public.test-d.ts"];
    assert.deepEqual(result.profile.vueTypeTestPaths, types);
    assert.ok(types.every(path => result.profile.testFilePaths.includes(path)));
    for (const path of ["packages/ui/src/value.ts", "packages/ui/tests/other.test.ts"]) {
      const impact = new ImpactAnalyzer().analyze(delta(path), result, result.profile);
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.ok(types.every(path => impact.affectedTests.some(test => test.path === path && test.reasons.includes("ALWAYS_RUN_POLICY"))));
      const plan = planSelectiveTestCommands(result.profile, impact.affectedTests.map(test => test.path));
      assert.equal(plan.refusalReason, undefined);
      assert.ok(types.every(path => plan.commands[0].args.includes(path.replace("packages/ui/", ""))));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Vue scoped syntax analysis follows generated implementations and their transitive imports", async () => {
  const root = fixture({
    "packages/ui/src/value.ts": 'export { value } from "../build/generated";',
    "packages/ui/build/generated.ts": 'export { value } from "../src/leaf";',
    "packages/ui/src/leaf.ts": "export const value = 1;",
  });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    assert.ok(result.graph.edges.some(edge => edge.from === "packages/ui/build/generated.ts" && edge.to === "packages/ui/src/leaf.ts"));
    const impact = new ImpactAnalyzer().analyze(delta("packages/ui/src/leaf.ts"), result, result.profile);
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
    assert.deepEqual(impact.affectedTests.map(test => test.path), ["packages/ui/tests/child.test.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Vue scope follows workspace symlinks before accepting a dependency as external", async () => {
  const root = fixture({
    "packages/ui/tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler","preserveSymlinks":true},"include":["src","tests"]}',
    "packages/ui/src/value.ts": 'export {value} from "shared";',
    "packages/shared/package.json": '{"name":"shared","main":"index.ts"}',
    "packages/shared/index.ts": "export const value = 1;",
  });
  try {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(join(root, "packages/shared"), join(root, "node_modules/shared"), "junction");
    const result = await buildDependencyGraph({ repoPath: root });
    assert.ok(result.adapterBlockers?.some(reason => reason.includes("boundary")));
    assert.equal(new ImpactAnalyzer().analyze(delta("packages/ui/src/value.ts"), result, result.profile).fallbackRequired, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Vue scope accepts physical third-party dependencies in root node_modules", async () => {
  const root = fixture({
    "packages/ui/tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler"},"include":["src","tests"]}',
    "packages/ui/src/value.ts": 'export {value} from "third-party";',
    "node_modules/third-party/package.json": '{"name":"third-party","main":"index.ts"}',
    "node_modules/third-party/index.ts": "export const value = 1;",
  });
  try {
    const result = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(result.adapterBlockers, []);
    assert.ok(result.references.some(ref => ref.specifier === "third-party" && ref.resolution === "external-package"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
