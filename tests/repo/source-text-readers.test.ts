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
import { readsFiles, repositoryFileReader, sourceTextReaders } from "../../src/repo/file-references.js";
import type { ImpactResult } from "../../src/repo/impact-types.js";

// The dogfood record's first miss (DentalPresence d5002718, 2026-11-26): a commit changed
// src/lib/index/public-profiles.ts, and a guard test that reads that file's source through a readFile helper
// and matches it against a pattern failed. It never imports the file, so the graph selected nothing for it.
const base = {
  "package.json": JSON.stringify({ name: "f", type: "module", scripts: { test: "node --test" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
  "src/lib/index/public-profiles.ts": "export const read = (slug: string) => `the ${slug} practice profile`;\n",
  "src/lib/index/market-benchmarks.ts": "export const benchmark = 1;\n",
  "src/lib/index/public-profiles.test.ts": "import { read } from './public-profiles';\nread('x');\n",
  "src/lib/index/market-benchmarks.test.ts": [
    "import assert from 'node:assert/strict';",
    "import { readFile } from 'node:fs/promises';",
    "import test from 'node:test';",
    "const source = (path: string) => readFile(path, 'utf8');",
    "test('profile reads stay fenced', async () => {",
    "  const profiles = await source('src/lib/index/public-profiles.ts');",
    "  assert.match(profiles, /practice profile/);",
    "});",
    "",
  ].join("\n"),
  // Names the file only in a comment and reads something else: not a reader.
  "src/lib/index/other.test.ts": [
    "import { readFileSync } from 'node:fs';",
    "// see src/lib/index/public-profiles.ts",
    "readFileSync('package.json', 'utf8');",
    "",
  ].join("\n"),
};

/** Commits `base`, then `head`, and analyses the delta like analyzeCheckout. */
async function analyzeChange(head: Record<string, string>): Promise<ImpactResult> {
  const dir = join(tmpdir(), `diffci-text-readers-${randomUUID()}`);
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

describe("tests that read a code file as text", () => {
  it("are selected when that code file changes", async () => {
    const impact = await analyzeChange({ "src/lib/index/public-profiles.ts": "export const read = (route: { slug: string }) => `the ${route.slug} practice profile`;\n" });
    assert.deepEqual(impact.fallbackReasons, []);
    assert.deepEqual(selected(impact), ["src/lib/index/market-benchmarks.test.ts", "src/lib/index/public-profiles.test.ts"]);
  });

  it("are not selected for a change to a file they do not read", async () => {
    const impact = await analyzeChange({ "src/lib/index/market-benchmarks.ts": "export const benchmark = 2;\n" });
    assert.ok(!selected(impact).includes("src/lib/index/other.test.ts"));
    assert.ok(!selected(impact).includes("src/lib/index/public-profiles.test.ts"));
  });
});

describe("sourceTextReaders", () => {
  const files: Record<string, string> = {
    "a.test.ts": "readFileSync(join(root, 'src/x.ts'), 'utf8');\n",
    "b.test.ts": "import { x } from '../src/x';\n",
    "c.test.py": "Path('src/x.ts').read_text()\n",
    "d.test.ts": "readFileSync('src/y.ts', 'utf8');\n",
  };
  const read = (path: string) => files[path];

  it("finds tests that call a file-reading API and name the path", () => {
    assert.deepEqual(sourceTextReaders("src/x.ts", Object.keys(files), read), ["a.test.ts", "c.test.py"]);
  });

  it("recognises file-reading calls", () => {
    assert.equal(readsFiles("await readFile(p)"), true);
    assert.equal(readsFiles("createReadStream(p)"), true);
    assert.equal(readsFiles("import { x } from './x'"), false);
    assert.equal(readsFiles(undefined), false);
  });
});
