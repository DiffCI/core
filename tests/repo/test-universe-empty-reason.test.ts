// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { GitDelta } from "../../src/git/types.js";

// A language adapter's repository has no package.json test framework, so the TEST_UNIVERSE_EMPTY
// reason read "Repository declares  but no test files were discovered".
test("an adapter repository with no tests names its runner in the empty-universe reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "diffci-empty-universe-"));
  const files: Record<string, string> = {
    "pom.xml": "<project><groupId>example</groupId><artifactId>tool</artifactId><version>1</version></project>",
    "src/main/java/example/Tool.java": "package example; public class Tool {}",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    const delta: GitDelta = {
      baseSha: "base", headSha: "head", files: [{ path: "src/main/java/example/Tool.java", changeType: "modified" }], directories: [],
      summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
      analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
    };
    const impact = new ImpactAnalyzer().analyze(delta, graph, graph.profile);
    assert.equal(impact.fallbackRequired, true);
    assert.ok(impact.fallbackReasons.includes("Repository declares Maven but no test files were discovered; full validation required"), impact.fallbackReasons.join("; "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
