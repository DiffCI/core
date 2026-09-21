import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph, classifyRepositoryProject } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import type { GitDelta } from "../../src/git/types.js";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-core-adapters-"));
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

test("Vue source change reaches the importing test through a component", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    "src/value.js": "export const value = 1;",
    "src/App.vue": '<script setup>import { value } from "./value.js";</script><template>{{ value }}</template>',
    "tests/app.test.js": 'import App from "../src/App.vue"; export const app = App;',
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.equal(classifyRepositoryProject(root).capable, true);
    assert.deepEqual(graph.adapterBlockers, []);
    const impact = new ImpactAnalyzer().analyze(delta("src/value.js"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((item) => item.path), ["tests/app.test.js"]);
    assert.equal(planSelectiveTestCommands(graph.profile, ["tests/app.test.js"]).groups[0]?.runnerId, "vitest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("Maven multi-module source change reaches downstream module tests", async () => {
  const root = fixture({
    "pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>library</module><module>application</module></modules></project>`,
    "library/pom.xml": `<project><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>library</artifactId></project>`,
    "library/src/main/java/example/Library.java": "package example; public class Library {}",
    "application/pom.xml": `<project><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>application</artifactId><dependencies><dependency><groupId>example</groupId><artifactId>library</artifactId><version>1</version></dependency></dependencies></project>`,
    "application/src/main/java/example/App.java": "package example; public class App {}",
    "application/src/test/java/example/AppTest.java": "package example; public class AppTest {}",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.equal(classifyRepositoryProject(root).capable, true);
    assert.deepEqual(graph.adapterBlockers, []);
    const impact = new ImpactAnalyzer().analyze(delta("library/src/main/java/example/Library.java"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((item) => item.path), ["application/src/test/java/example/AppTest.java"]);
    const plan = planSelectiveTestCommands(graph.profile, impact.affectedTests.map((item) => item.path));
    assert.equal(plan.groups[0]?.runnerId, "maven:surefire");
    assert.deepEqual(plan.commands[0]?.args, ["-pl", "application", "-am", "test"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
