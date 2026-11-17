// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { computeAnalysis } from "../../src/git/git-diff.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { matchesGlob } from "../../src/repo/test-discovery.js";

// matchesGlob passed `+`, `$` and `^` to RegExp as operators, and a bare `**` stayed in one segment.
// Expected values are picomatch 4's.
describe("matchesGlob keeps regex metacharacters literal", () => {
  it("matches `$`, `+` and `^` literally and never throws", () => {
    assert.equal(matchesGlob("app/routes/users.$id.tsx", "app/routes/users.$id.tsx"), true);
    assert.equal(matchesGlob("app/routes/_auth+/login.tsx", "app/routes/_auth+/**"), true);
    assert.equal(matchesGlob("app/routes/_auth/login.tsx", "app/routes/_auth+/**"), false);
    assert.equal(matchesGlob("c++/x.cc", "c++/**"), true);
    assert.equal(matchesGlob("^a/x.ts", "^a/**"), true);
    assert.equal(matchesGlob("a/x.ts", "^a/**"), false);
  });

  it("keeps `[^...]` classes, groups and extglobs", () => {
    assert.equal(matchesGlob("src/a.ts", "src/[^b].ts"), true);
    assert.equal(matchesGlob("src/b.ts", "src/[^b].ts"), false);
    assert.equal(matchesGlob("a.spec.ts", "**/*.(test|spec).ts"), true);
    assert.equal(matchesGlob("src/a.test.tsx", "**/*.test.?(c|m)[jt]s?(x)"), true);
  });

  it("matches every path with a bare **", () => {
    assert.equal(matchesGlob("a.ts", "**"), true);
    assert.equal(matchesGlob("a/b/c.ts", "**"), true);
  });
});

describe("a declared input that names a Remix route file", () => {
  it("selects its declared tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "diffci-glob-literals-"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", type: "module", devDependencies: { vitest: "^3.0.0" }, scripts: { test: "vitest run" } }),
      "diffci.json": JSON.stringify({ inputs: [{ files: ["app/routes/users.$id.tsx"], tests: ["e2e/users.test.ts"] }] }),
      "app/routes/users.$id.tsx": "export default function User() { return null; }\n",
      "src/a.ts": "export const a = 1;\n",
      "src/a.test.ts": "import { a } from './a';\nimport { test } from 'vitest';\ntest('a', () => a);\n",
      "e2e/users.test.ts": "import { test } from 'vitest';\ntest('u', async () => { await fetch('http://localhost/users/1'); });\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      const changed: ChangedFile[] = [{ path: "app/routes/users.$id.tsx", changeType: "modified" }];
      const delta: GitDelta = {
        baseSha: "base", headSha: "head", files: changed, directories: [],
        summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
        analysis: computeAnalysis(changed),
      };
      const read = (path: string) => { try { return readFileSync(join(root, path), "utf8"); } catch { return undefined; } };
      const impact = new ImpactAnalyzer().analyze(delta, graph, graph.profile, { repositoryFiles: new Set(Object.keys(files)), readRepositoryFile: read });
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.deepEqual(impact.affectedTests.map((test) => test.path), ["e2e/users.test.ts"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
