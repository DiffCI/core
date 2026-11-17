import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { GitDelta } from "../../src/git/types.js";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-maven-comments-"));
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
const application = "<project><groupId>example</groupId><artifactId>application</artifactId><version>1</version><dependencies><dependency><groupId>example</groupId><artifactId>library</artifactId><version>1</version></dependency></dependencies></project>";

test("Maven ignores an <artifactId> inside an XML comment", async () => {
  const root = fixture({
    "pom.xml": parent,
    "library/pom.xml": "<project><modelVersion>4.0.0</modelVersion><!-- renamed from <artifactId>legacy-library</artifactId> --><groupId>example</groupId><artifactId>library</artifactId><version>1</version></project>",
    "library/src/main/java/example/Library.java": "package example; public class Library {}",
    "library/src/test/java/example/LibraryTest.java": "package example; class LibraryTest {}",
    "application/pom.xml": application,
    "application/src/main/java/example/App.java": "package example; public class App {}",
    "application/src/test/java/example/AppTest.java": "package example; class AppTest {}",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    const impact = new ImpactAnalyzer().analyze(delta("library/src/main/java/example/Library.java"), graph, graph.profile);
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
    assert.deepEqual(impact.affectedTests.map((item) => item.path).sort(), ["application/src/test/java/example/AppTest.java", "library/src/test/java/example/LibraryTest.java"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Maven ignores a commented-out <sourceDirectory>", async () => {
  const root = fixture({
    "pom.xml": parent,
    "library/pom.xml": "<project><groupId>example</groupId><artifactId>library</artifactId><version>1</version><build><!-- <sourceDirectory>src/java</sourceDirectory> --></build></project>",
    "library/src/main/java/example/Library.java": "package example; public class Library {}",
    "application/pom.xml": application,
    "application/src/main/java/example/App.java": "package example; public class App {}",
    "application/src/test/java/example/AppTest.java": "package example; class AppTest {}",
  });
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
