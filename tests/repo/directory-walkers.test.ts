// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import type { ImpactResult } from "../../src/repo/impact-types.js";

// The CI replay's one miss (DiffCI.com dc-263c534de5d9): a commit added a script with a shell call, and
// a test that lists every file under scripts/ failed. Nothing imports the new script, so the graph
// selected nothing for it.
const base = {
  "package.json": JSON.stringify({ name: "f", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src", "scripts", "tests"] }),
  "src/other.ts": "export const other = 1;\n",
  "scripts/build.ts": "export const build = () => 1;\n",
  "tests/other.test.ts": "import { other } from '../src/other';\nexport { other };\n",
  "tests/scripts/shell-invariant.test.ts": [
    "import { readdirSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "for (const name of readdirSync(join(process.cwd(), 'scripts'))) {",
    "  if (readFileSync(join('scripts', name), 'utf8').includes('execSync(')) throw new Error(name);",
    "}",
    "",
  ].join("\n"),
  "tests/scripts/build-text.test.ts": "import { readFileSync } from 'node:fs';\nreadFileSync('scripts/build.ts', 'utf8');\n",
};

/** Commits `base`, then `head`, and analyses the delta like analyzeCheckout. */
async function analyzeChange(head: Record<string, string>): Promise<ImpactResult> {
  const dir = join(tmpdir(), `diffci-walkers-${randomUUID()}`);
  const write = (entries: Record<string, string>) => {
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  try {
    mkdirSync(dir, { recursive: true });
    execSync("git init -q && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(base);
    execSync("git add -A && git commit -qm base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(head);
    execSync("git add -A && git commit -qm head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    return new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const selected = (impact: ImpactResult) => impact.affectedTests.map((test) => test.path).sort();

describe("tests that walk a directory", () => {
  it("are selected when a code file is added under the directory they list", async () => {
    const impact = await analyzeChange({ "scripts/ci-reproduction.ts": "import { execSync } from 'node:child_process';\nexecSync('true');\n" });
    assert.deepEqual(impact.fallbackReasons, []);
    assert.deepEqual(selected(impact), ["tests/scripts/shell-invariant.test.ts"]);
  });

  it("are selected when a code file under that directory changes", async () => {
    const impact = await analyzeChange({ "scripts/build.ts": "export const build = () => 2;\n" });
    assert.ok(selected(impact).includes("tests/scripts/shell-invariant.test.ts"));
  });

  it("are not selected for a change outside the directory they list", async () => {
    const impact = await analyzeChange({ "src/other.ts": "export const other = 2;\n" });
    assert.deepEqual(selected(impact), ["tests/other.test.ts"]);
  });
});
