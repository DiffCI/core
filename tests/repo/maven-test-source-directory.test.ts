// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { GitDelta } from "../../src/git/types.js";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-maven-test-root-"));
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

const parent = "<project><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>library</module><module>application</module></modules></project>";

function application(build: string): string {
  return `<project><groupId>example</groupId><artifactId>application</artifactId><version>1</version><dependencies><dependency><groupId>example</groupId><artifactId>library</artifactId><version>1</version></dependency></dependencies><build>${build}</build></project>`;
}

function reactor(build: string, testPath: string): Record<string, string> {
  return {
    "pom.xml": parent,
    "library/pom.xml": "<project><groupId>example</groupId><artifactId>library</artifactId><version>1</version></project>",
    "library/src/main/java/example/Library.java": "package example; public class Library {}",
    "library/src/test/java/example/LibraryTest.java": "package example; class LibraryTest {}",
    "application/pom.xml": application(build),
    "application/src/main/java/example/App.java": "package example; public class App {}",
    [testPath]: "package example; class AppTest {}",
  };
}

const blocker = /custom source roots require full validation/;

for (const declared of ["tests", "./tests/", "src/it/../../tests"]) {
  test(`Maven finds tests under a relative <testSourceDirectory> (${declared})`, async () => {
    const root = fixture(reactor(`<testSourceDirectory>${declared}</testSourceDirectory>`, "application/tests/example/AppTest.java"));
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.deepEqual(graph.adapterBlockers, []);
      assert.equal(graph.profile.mavenTestModules?.["application/tests/example/AppTest.java"], "application");
      const impact = new ImpactAnalyzer().analyze(delta("library/src/main/java/example/Library.java"), graph, graph.profile);
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.deepEqual(impact.affectedTests.map((item) => item.path).sort(), ["application/tests/example/AppTest.java", "library/src/test/java/example/LibraryTest.java"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("Maven ignores test-named files under src/test/java once <testSourceDirectory> moves the root", async () => {
  const files = reactor("<testSourceDirectory>tests</testSourceDirectory>", "application/tests/example/AppTest.java");
  files["application/src/test/java/example/StaleTest.java"] = "package example; class StaleTest {}";
  const root = fixture(files);
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    assert.equal(graph.profile.mavenTestModules?.["application/src/test/java/example/StaleTest.java"], undefined);
    assert.ok(graph.profile.mavenTestModules?.["application/tests/example/AppTest.java"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Maven still falls back for a custom <sourceDirectory> next to a resolvable <testSourceDirectory>", async () => {
  const root = fixture(reactor("<sourceDirectory>src/java</sourceDirectory><testSourceDirectory>tests</testSourceDirectory>", "application/tests/example/AppTest.java"));
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.ok(graph.adapterBlockers?.some((reason) => blocker.test(reason)), graph.adapterBlockers?.join("; "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, build] of [
  ["a property", "<testSourceDirectory>${project.basedir}/tests</testSourceDirectory>"],
  ["an absolute path", "<testSourceDirectory>/srv/tests</testSourceDirectory>"],
  ["a Windows drive", "<testSourceDirectory>C:/tests</testSourceDirectory>"],
  ["a backslash separator", "<testSourceDirectory>tests\\example</testSourceDirectory>"],
  ["a path outside the module", "<testSourceDirectory>../shared-tests</testSourceDirectory>"],
  ["the module root itself", "<testSourceDirectory>.</testSourceDirectory>"],
  ["two different declarations", "<testSourceDirectory>tests</testSourceDirectory><profiles><profile><id>it</id><build><testSourceDirectory>it</testSourceDirectory></build></profile></profiles>"],
]) {
  test(`Maven falls back for a <testSourceDirectory> with ${name}`, async () => {
    const root = fixture(reactor(build, "application/tests/example/AppTest.java"));
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.ok(graph.adapterBlockers?.some((reason) => blocker.test(reason)), graph.adapterBlockers?.join("; "));
      const impact = new ImpactAnalyzer().analyze(delta("library/src/main/java/example/Library.java"), graph, graph.profile);
      assert.equal(impact.fallbackRequired, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const [name, build] of [
  ["only inside a profile", "<profiles><profile><id>it</id><build><testSourceDirectory>tests</testSourceDirectory></build></profile></profiles>"],
  ["in the build and repeated inside a profile", "<testSourceDirectory>tests</testSourceDirectory><profiles><profile><id>it</id><build><testSourceDirectory>tests</testSourceDirectory></build></profile></profiles>"],
]) {
  test(`Maven falls back for a <testSourceDirectory> ${name}`, async () => {
    const root = fixture(reactor(build, "application/src/test/java/example/AppTest.java"));
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.ok(graph.adapterBlockers?.some((reason) => blocker.test(reason)), graph.adapterBlockers?.join("; "));
      const impact = new ImpactAnalyzer().analyze(delta("library/src/main/java/example/Library.java"), graph, graph.profile);
      assert.equal(impact.fallbackRequired, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

function inheriting(parentBuild: string, childBuild: string, testPath: string): Record<string, string> {
  const files = reactor(childBuild, testPath);
  files["pom.xml"] = parent.replace("</modules>", `</modules><build>${parentBuild}</build>`);
  files["application/pom.xml"] = files["application/pom.xml"]!.replace("<project>", "<project><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent>");
  return files;
}

test("Maven falls back for a module that inherits a custom <testSourceDirectory> from a local parent", async () => {
  const root = fixture(inheriting("<testSourceDirectory>tests</testSourceDirectory>", "", "application/tests/example/AppTest.java"));
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.ok(graph.adapterBlockers?.some((reason) => reason.startsWith("Maven application/pom.xml:") && blocker.test(reason)), graph.adapterBlockers?.join("; "));
    const impact = new ImpactAnalyzer().analyze(delta("library/src/main/java/example/Library.java"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, parentBuild, childBuild, testPath] of [
  ["the parent declares the default root", "<testSourceDirectory>src/test/java</testSourceDirectory>", "", "application/src/test/java/example/AppTest.java"],
  ["the module declares its own root", "<testSourceDirectory>it</testSourceDirectory>", "<testSourceDirectory>tests</testSourceDirectory>", "application/tests/example/AppTest.java"],
]) {
  test(`Maven resolves an inheriting module's test root when ${name}`, async () => {
    const root = fixture(inheriting(parentBuild, childBuild, testPath));
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.deepEqual(graph.adapterBlockers, []);
      assert.equal(graph.profile.mavenTestModules?.[testPath], "application");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
