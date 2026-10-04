import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph, classifyRepositoryProject, hydrateDependencyGraph } from "../../src/repo/graph.js";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { analyzeGoMetadata, goAdapter } from "../../src/repo/adapters/go.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import type { GitDelta } from "../../src/git/types.js";
import type { DependencyGraph } from "../../src/repo/types.js";

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

test("root Go module metadata selects transitive owners and excludes unrelated packages", () => {
  const files = {
    "go.mod": "module example.com/project\n\ngo 1.24\n",
    "shared/value.go": "package shared\nconst Value = 1\n",
    "shared/value_test.go": "package shared\nfunc TestValue() {}\n",
    "service/service.go": "package service\nimport _ \"example.com/project/shared\"\n",
    "service/service_test.go": "package service\nfunc TestService() {}\n",
    "unrelated/value.go": "package unrelated\nconst Value = 2\n",
    "unrelated/value_test.go": "package unrelated\nfunc TestValue() {}\n",
  };
  const root = fixture(files);
  try {
    const pkg = (path: string, importPath: string, options: Record<string, unknown>) => ({
      Dir: join(root, path), ImportPath: importPath, Name: path, ...options,
    });
    const metadata = [
      pkg("shared", "example.com/project/shared", { GoFiles: ["value.go"], TestGoFiles: ["value_test.go"] }),
      pkg("service", "example.com/project/service", { GoFiles: ["service.go"], TestGoFiles: ["service_test.go"], Imports: ["example.com/project/shared"] }),
      pkg("unrelated", "example.com/project/unrelated", { GoFiles: ["value.go"], TestGoFiles: ["value_test.go"] }),
    ].map(value => JSON.stringify(value)).join("\n");
    const profile = analyzeRepository({ repoPath: root });
    const contribution = analyzeGoMetadata({ repoPath: root, files: Object.keys(files), profile }, metadata);
    assert.deepEqual(contribution.blockers, []);
    profile.goTestPackages = contribution.testPackages;
    const graph = hydrateDependencyGraph({
      nodes: contribution.sourcePaths.map(path => ({ path, isSource: true, isAsset: false, isTest: path.endsWith("_test.go"), isEntryPoint: false })),
      edges: contribution.edges,
    } as unknown as DependencyGraph, root);
    const affected = graph.transitiveDependentsOf("shared/value.go").filter(path => path.endsWith("_test.go"));
    assert.deepEqual(affected, ["service/service_test.go", "shared/value_test.go"]);
    assert.ok(!affected.includes("unrelated/value_test.go"));
    const plan = planSelectiveTestCommands(profile, affected);
    assert.deepEqual(plan.commands[0]?.args, ["test", "-mod=readonly", "-json", "-count=1", "./service", "./shared"]);

    const unsupported = goAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "nested/go.mod"], profile });
    assert.ok(unsupported.blockers.includes("Go support requires one root go.mod; workspaces and nested modules require full validation"));
    assert.deepEqual(unsupported.testPackages, {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const unresolved of [false, true]) {
  test(`Vue transitive selection ${unresolved ? "falls back on unresolved imports" : "excludes unrelated tests with complete evidence"}`, async () => {
    const root = fixture({
      "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
      "src/value.js": "export const value = 1;",
      "src/derived.js": 'export { value } from "./value.js";',
      "src/App.vue": `<script setup>import { value } from "./derived.js";${unresolved ? 'import "./missing.js";' : ""}</script><template>{{ value }}</template>`,
      "src/unrelated.js": "export const unrelated = 2;",
      "tests/app.test.js": 'import App from "../src/App.vue"; export const app = App;',
      "tests/unrelated.test.js": 'import { unrelated } from "../src/unrelated.js"; export const result = unrelated;',
    });
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      const impact = new ImpactAnalyzer().analyze(delta("src/value.js"), graph, graph.profile);
      assert.equal(impact.fallbackRequired, unresolved);
      assert.deepEqual(impact.affectedTests.map((item) => item.path), ["tests/app.test.js"]);
      const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta: delta("src/value.js"), impact, profile: graph.profile });
      assert.equal(plan.mode, unresolved ? "FULL" : "SELECTIVE");
      assert.deepEqual(plan.selectedTests, unresolved
        ? ["tests/app.test.js", "tests/unrelated.test.js"]
        : ["tests/app.test.js"]);
      assert.deepEqual(plan.skippedTests, unresolved ? [] : ["tests/unrelated.test.js"]);
      if (!unresolved) assert.deepEqual(graph.adapterBlockers, []);
      else assert.ok(impact.fallbackReasons.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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

test("Maven plan uses the repository's declared CI lifecycle and profiles", async () => {
  const root = fixture({
    "diffci.json": JSON.stringify({ maven: { goal: "verify", profiles: ["run-its"] } }),
    "pom.xml": "<project><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><modules><module>tools</module></modules></project>",
    "tools/pom.xml": "<project><artifactId>tools</artifactId></project>",
    "tools/src/main/java/example/Tool.java": "package example; public class Tool {}",
    "tools/src/test/java/example/ToolTest.java": "package example; public class ToolTest {}",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    const plan = planSelectiveTestCommands(graph.profile, ["tools/src/test/java/example/ToolTest.java"]);
    assert.deepEqual(plan.commands[0]?.args, ["-pl", "tools", "-am", "verify", "-P", "run-its"]);

    writeFileSync(join(root, "diffci.json"), JSON.stringify({ maven: { goal: "deploy", profiles: ["run-its;unsafe"] } }));
    const invalid = await buildDependencyGraph({ repoPath: root });
    assert.ok(invalid.adapterBlockers?.includes("Invalid Maven lifecycle goal or profiles"));
    const refused = planSelectiveTestCommands(invalid.profile, ["tools/src/test/java/example/ToolTest.java"]);
    assert.deepEqual(refused.commands, []);
    assert.match(refused.refusalReason ?? "", /Invalid Maven lifecycle goal or profiles/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Spring gs-multi-module shape selects application when library changes", async () => {
  const root = fixture({
    "pom.xml": `<project><groupId>org.springframework</groupId><artifactId>gs-multi-module</artifactId><version>0.0.1-SNAPSHOT</version><packaging>pom</packaging><modules><module>library</module><module>application</module></modules></project>`,
    "library/pom.xml": `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.11</version></parent><groupId>com.example</groupId><artifactId>library</artifactId><version>0.0.1-SNAPSHOT</version></project>`,
    "library/src/main/java/com/example/service/MyService.java": "package com.example.service; public class MyService {}",
    "library/src/test/java/com/example/service/MyServiceTest.java": "package com.example.service; public class MyServiceTest {}",
    "application/pom.xml": `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.11</version></parent><groupId>com.example</groupId><artifactId>application</artifactId><version>0.0.1-SNAPSHOT</version><dependencies><dependency><groupId>com.example</groupId><artifactId>library</artifactId><version>\${project.version}</version></dependency></dependencies></project>`,
    "application/src/main/java/com/example/application/DemoApplication.java": "package com.example.application; public class DemoApplication {}",
    "application/src/test/java/com/example/application/DemoApplicationTest.java": "package com.example.application; public class DemoApplicationTest {}",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    const impact = new ImpactAnalyzer().analyze(delta("library/src/main/java/com/example/service/MyService.java"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((item) => item.path), [
      "application/src/test/java/com/example/application/DemoApplicationTest.java",
      "library/src/test/java/com/example/service/MyServiceTest.java",
    ]);
    const plan = planSelectiveTestCommands(graph.profile, impact.affectedTests.map((item) => item.path));
    assert.deepEqual(plan.commands[0]?.args, ["-pl", "application,library", "-am", "test"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Maven Kotlin multi-module source change reaches downstream tests", async () => {
  const root = fixture({
    "pom.xml": `<project><groupId>org.example</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>common</module><module>selector</module></modules></project>`,
    "common/pom.xml": `<project><parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>common</artifactId></project>`,
    "common/src/main/kotlin/org/example/Config.kt": "package org.example; class Config",
    "common/src/test/kotlin/org/example/ConfigTest.kt": "package org.example; class ConfigTest",
    "selector/pom.xml": `<project><parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>selector</artifactId><dependencies><dependency><groupId>org.example</groupId><artifactId>common</artifactId><version>1</version></dependency></dependencies></project>`,
    "selector/src/main/kotlin/org/example/Selector.kt": "package org.example; class Selector",
    "selector/src/test/kotlin/org/example/SelectorTest.kt": "package org.example; class SelectorTest",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.equal(classifyRepositoryProject(root).capable, true);
    assert.deepEqual(graph.adapterBlockers, []);
    const impact = new ImpactAnalyzer().analyze(delta("common/src/main/kotlin/org/example/Config.kt"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((item) => item.path), [
      "common/src/test/kotlin/org/example/ConfigTest.kt",
      "selector/src/test/kotlin/org/example/SelectorTest.kt",
    ]);
    const plan = planSelectiveTestCommands(graph.profile, impact.affectedTests.map((item) => item.path));
    assert.deepEqual(plan.commands[0]?.args, ["-pl", "common,selector", "-am", "test"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Jicofo-style Maven property dependency connects Kotlin modules", async () => {
  const root = fixture({
    "pom.xml": `<project><groupId>org.jitsi</groupId><artifactId>jicofo-parent</artifactId><version>1.1-SNAPSHOT</version><packaging>pom</packaging><modules><module>jicofo-common</module><module>jicofo-selector</module></modules></project>`,
    "jicofo-common/pom.xml": `<project><parent><groupId>org.jitsi</groupId><artifactId>jicofo-parent</artifactId><version>1.1-SNAPSHOT</version></parent><artifactId>jicofo-common</artifactId></project>`,
    "jicofo-common/src/main/kotlin/org/jitsi/jicofo/JicofoConfig.kt": "package org.jitsi.jicofo; class JicofoConfig",
    "jicofo-common/src/test/kotlin/org/jitsi/jicofo/JicofoConfigTest.kt": "package org.jitsi.jicofo; class JicofoConfigTest",
    "jicofo-selector/pom.xml": `<project><parent><groupId>org.jitsi</groupId><artifactId>jicofo-parent</artifactId><version>1.1-SNAPSHOT</version></parent><artifactId>jicofo-selector</artifactId><dependencies><dependency><groupId>\${project.groupId}</groupId><artifactId>jicofo-common</artifactId><version>\${project.version}</version></dependency></dependencies></project>`,
    "jicofo-selector/src/main/kotlin/org/jitsi/jicofo/bridge/BridgeSelector.kt": "package org.jitsi.jicofo.bridge; class BridgeSelector",
    "jicofo-selector/src/test/kotlin/org/jitsi/jicofo/bridge/BridgeSelectorTest.kt": "package org.jitsi.jicofo.bridge; class BridgeSelectorTest",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    const impact = new ImpactAnalyzer().analyze(delta("jicofo-common/src/main/kotlin/org/jitsi/jicofo/JicofoConfig.kt"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((item) => item.path), [
      "jicofo-common/src/test/kotlin/org/jitsi/jicofo/JicofoConfigTest.kt",
      "jicofo-selector/src/test/kotlin/org/jitsi/jicofo/bridge/BridgeSelectorTest.kt",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Jicofo-style three-module reactor propagates common changes through selector to jicofo", async () => {
  const root = fixture({
    "pom.xml": `<project><groupId>org.jitsi</groupId><artifactId>jicofo-parent</artifactId><version>1.1-SNAPSHOT</version><packaging>pom</packaging><modules><module>jicofo-common</module><module>jicofo-selector</module><module>jicofo</module></modules></project>`,
    "jicofo-common/pom.xml": `<project><parent><groupId>org.jitsi</groupId><artifactId>jicofo-parent</artifactId><version>1.1-SNAPSHOT</version></parent><artifactId>jicofo-common</artifactId></project>`,
    "jicofo-common/src/main/kotlin/org/jitsi/jicofo/JicofoConfig.kt": "package org.jitsi.jicofo; class JicofoConfig",
    "jicofo-common/src/test/kotlin/org/jitsi/jicofo/JicofoConfigTest.kt": "package org.jitsi.jicofo; class JicofoConfigTest",
    "jicofo-selector/pom.xml": `<project><parent><groupId>org.jitsi</groupId><artifactId>jicofo-parent</artifactId><version>1.1-SNAPSHOT</version></parent><artifactId>jicofo-selector</artifactId><dependencies><dependency><groupId>\${project.groupId}</groupId><artifactId>jicofo-common</artifactId></dependency></dependencies></project>`,
    "jicofo-selector/src/main/kotlin/org/jitsi/jicofo/bridge/BridgeSelector.kt": "package org.jitsi.jicofo.bridge; class BridgeSelector",
    "jicofo-selector/src/test/kotlin/org/jitsi/jicofo/bridge/BridgeSelectorTest.kt": "package org.jitsi.jicofo.bridge; class BridgeSelectorTest",
    "jicofo/pom.xml": `<project><parent><groupId>org.jitsi</groupId><artifactId>jicofo-parent</artifactId><version>1.1-SNAPSHOT</version></parent><artifactId>jicofo</artifactId><dependencies><dependency><groupId>\${project.groupId}</groupId><artifactId>jicofo-common</artifactId></dependency><dependency><groupId>\${project.groupId}</groupId><artifactId>jicofo-selector</artifactId></dependency></dependencies></project>`,
    "jicofo/src/main/kotlin/org/jitsi/jicofo/JicofoServices.kt": "package org.jitsi.jicofo; class JicofoServices",
    "jicofo/src/test/kotlin/org/jitsi/jicofo/JicofoServicesTest.kt": "package org.jitsi.jicofo; class JicofoServicesTest",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    const impact = new ImpactAnalyzer().analyze(delta("jicofo-common/src/main/kotlin/org/jitsi/jicofo/JicofoConfig.kt"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(impact.affectedTests.map((item) => item.path), [
      "jicofo-common/src/test/kotlin/org/jitsi/jicofo/JicofoConfigTest.kt",
      "jicofo-selector/src/test/kotlin/org/jitsi/jicofo/bridge/BridgeSelectorTest.kt",
      "jicofo/src/test/kotlin/org/jitsi/jicofo/JicofoServicesTest.kt",
    ]);
    const plan = planSelectiveTestCommands(graph.profile, impact.affectedTests.map((item) => item.path));
    assert.deepEqual(plan.commands[0]?.args, ["-pl", "jicofo,jicofo-common,jicofo-selector", "-am", "test"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
