// SPDX-License-Identifier: MIT
// Regression fixture for issue #53: a non-selection Vitest config edit still falls back.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
const config = (reporter: string, timeout: number) =>
  "import { defineConfig } from 'vitest/config';\n" +
  "export default defineConfig({ test: { include: ['src/**/*.test.ts'], " +
  "reporters: ['" + reporter + "'], testTimeout: " + timeout + " } });\n";

describe("Vitest config-only changes: conservative fallback (#53)", () => {
  for (const testCase of [
    { name: "reporter-only", changed: config("verbose", 5000) },
    { name: "timeout-only", changed: config("default", 10000) },
  ]) {
    it(testCase.name + " edit still requests the full test suite", async () => {
      const root = mkdtempSync(join(tmpdir(), "diffci-vitest-config-"));
      try {
        git(root, "init", "--quiet");
        git(root, "config", "user.email", "fixture@diffci.local");
        git(root, "config", "user.name", "DiffCI fixture");
        write(root, "package.json", JSON.stringify({
          name: "vitest-config-fixture", private: true, type: "module",
          scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0" },
        }));
        write(root, "src/adder.ts", "export const add = (a: number, b: number) => a + b;\n");
        write(root, "src/adder.test.ts",
          "import { test, expect } from 'vitest';\n" +
          "import { add } from './adder';\n" +
          "test('adds', () => expect(add(1, 2)).toBe(3));\n");
        write(root, "vitest.config.ts", config("default", 5000));
        git(root, "add", "-A");
        git(root, "commit", "--quiet", "-m", "baseline");
        const baseSha = git(root, "rev-parse", "HEAD");
        write(root, "vitest.config.ts", testCase.changed);
        git(root, "add", "-A");
        git(root, "commit", "--quiet", "-m", testCase.name);
        const headSha = git(root, "rev-parse", "HEAD");

        const analyzed = await analyzeGitDelta({ repoPath: root, baseSha, headSha });
        assert.equal(analyzed.success, true);
        if (!analyzed.success) return;
        const delta = analyzed.delta;
        assert.deepEqual(delta.files.map((f) => f.path), ["vitest.config.ts"]);
        assert.equal(delta.analysis.configChanged, true);
        assert.deepEqual(delta.analysis.signalPaths?.config, ["vitest.config.ts"]);

        const graph = await buildDependencyGraph({ repoPath: root, excludeDirs: [".git", "node_modules"] });
        const impact = new ImpactAnalyzer().analyze(delta, graph, graph.profile, {
          repositoryFiles: analyzed.inventory?.files,
          readRepositoryFile: repositoryFileReader(root),
        });
        assert.equal(impact.fallbackRequired, true);
        assert.ok(impact.riskSignals.some((s) => s.reason === "CONFIG_GLOBAL"));
        assert.ok(impact.fallbackReasons.some((r) => /Configuration file\(s\) changed/.test(r)));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
