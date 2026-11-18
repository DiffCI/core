// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

// TypeScript resolves `./foo` to a hand-written `foo.d.ts` next to `foo.js`, so the graph's only edge
// went to the declaration. The runner loads `foo.js`, and a change to it selected nothing.
function write(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
}

async function change(files: Record<string, string>, path: string, content: string) {
  const dir = join(tmpdir(), `diffci-dts-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(dir, {
      "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^2.0.0" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src"] }),
      "src/other.ts": "export const other = 1;\n",
      "src/other.test.ts": "import { other } from './other';\nimport { test } from 'vitest';\ntest('o', () => { void other; });\n",
      ...files,
    });
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, { [path]: content });
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
    return { tests: impact.affectedTests.map((t) => t.path).sort(), fallback: impact.fallbackReasons };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const user = (specifier: string) => `import { foo } from '${specifier}';\nexport const bar = () => foo() + 1;\n`;
const barTest = "import { bar } from './bar';\nimport { test, expect } from 'vitest';\ntest('b', () => expect(bar()).toBe(2));\n";

for (const specifier of ["./foo.js", "./foo"]) {
  test(`a change to foo.js selects the tests that import it as ${specifier} through foo.d.ts`, async () => {
    const result = await change({
      "src/foo.js": "export function foo() { return 1; }\n",
      "src/foo.d.ts": "export declare function foo(): number;\n",
      "src/bar.ts": user(specifier),
      "src/bar.test.ts": barTest,
    }, "src/foo.js", "export function foo() { return 2; }\n");
    assert.deepEqual(result, { tests: ["src/bar.test.ts"], fallback: [] });
  });
}

test("foo.d.mts pairs with foo.mjs", async () => {
  const result = await change({
    "src/foo.mjs": "export function foo() { return 1; }\n",
    "src/foo.d.mts": "export declare function foo(): number;\n",
    "src/bar.ts": user("./foo.mjs"),
    "src/bar.test.ts": barTest,
  }, "src/foo.mjs", "export function foo() { return 2; }\n");
  assert.deepEqual(result, { tests: ["src/bar.test.ts"], fallback: [] });
});
