import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { GitDelta } from "../../src/git/types.js";

// Failsafe, which `"maven": { "goal": "verify" }` runs, includes **/IT*.java, **/*IT.java and
// **/*ITCase.java by default. A module whose only tests use the first or last name had no test files.
test("Maven verify selects a module whose tests follow Failsafe's IT* and *ITCase names", async () => {
  const pom = (artifactId: string, dependencies = "") => `<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>${artifactId}</artifactId><version>1</version><dependencies>${dependencies}</dependencies></project>`;
  const files: Record<string, string> = {
    "diffci.json": JSON.stringify({ maven: { goal: "verify" } }),
    "pom.xml": "<project><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>library</module><module>service</module></modules></project>",
    "library/pom.xml": pom("library"),
    "library/src/main/java/example/Library.java": "package example; public class Library {}",
    "library/src/test/java/example/LibraryTest.java": "package example; class LibraryTest {}",
    "service/pom.xml": pom("service", "<dependency><groupId>example</groupId><artifactId>library</artifactId><version>1</version></dependency>"),
    "service/src/main/java/example/Service.java": "package example; public class Service {}",
    "service/src/test/java/example/ITServiceFlow.java": "package example; class ITServiceFlow {}",
    "service/src/test/java/example/ServiceITCase.java": "package example; class ServiceITCase {}",
  };
  const root = mkdtempSync(join(tmpdir(), "diffci-maven-failsafe-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    const delta: GitDelta = {
      baseSha: "base", headSha: "head", files: [{ path: "service/src/main/java/example/Service.java", changeType: "modified" }], directories: [],
      summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
      analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
    };
    const impact = new ImpactAnalyzer().analyze(delta, graph, graph.profile);
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
    assert.deepEqual(impact.affectedTests.map((item) => item.path).sort(), ["service/src/test/java/example/ITServiceFlow.java", "service/src/test/java/example/ServiceITCase.java"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
