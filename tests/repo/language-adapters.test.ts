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
