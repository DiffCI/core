// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { compiledProjects, projectRoots } from "../../src/repo/compiled-projects.js";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";

const files = {
  "tsconfig.json": `{ // root\n "compilerOptions": { "strict": true }, "include": ["src", "tests"] }`,
  "tsconfig.client.json": `{ "extends": "./tsconfig.json", "files": ["src/client/cli.ts"], "include": [] }`,
  "tsconfig.build.json": `{ "extends": "./tsconfig.json", "exclude": ["tests"] }`,
  "src/client/cli.ts": "import { run } from './run.js';",
  "src/client/run.ts": "export const run = 1;",
  "src/server/api.ts": "export const api = 1;",
  "tests/cli.test.ts": `execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.client.json"]);`,
  "tests/fixture.test.ts": `writeFileSync("tsconfig.client.json", "{}"); // no compiler here`,
  "tests/unit.test.ts": `import { api } from "../src/server/api.js";`,
};
const read = (path: string) => (files as Record<string, string>)[path];
const deps: Record<string, string[]> = { "src/client/cli.ts": ["src/client/run.ts"] };

describe("projectRoots", () => {
  it("reads files, include and exclude, inheriting through extends", () => {
    const list = Object.keys(files);
    assert.deepEqual(projectRoots("tsconfig.client.json", { files: list, read }), ["src/client/cli.ts"]);
    assert.deepEqual(projectRoots("tsconfig.build.json", { files: list, read }), ["src/client/cli.ts", "src/client/run.ts", "src/server/api.ts"]);
  });
});

describe("compiledProjects", () => {
  it("links a test that runs tsc on a named project to every file that project compiles", () => {
    const projects = compiledProjects({ files: Object.keys(files), read, isTestFile: (p) => p.endsWith(".test.ts"), dependenciesOf: (p) => deps[p] ?? [] });
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!.config, "tsconfig.client.json");
    assert.deepEqual(projects[0]!.tests, ["tests/cli.test.ts"]);
    assert.deepEqual([...projects[0]!.files].sort(), ["src/client/cli.ts", "src/client/run.ts", "tsconfig.client.json"]);
  });
});

describe("end to end", () => {
  it("selects the compiling test when a file imported by the project root changes", async () => {
    const dir = join(tmpdir(), `diffci-compiled-${randomUUID()}`);
    const write = (entries: Record<string, string>) => { for (const [p, c] of Object.entries(entries)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } };
    try {
      mkdirSync(dir, { recursive: true });
      execSync("git init -q && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
      write({ ...files, "package.json": JSON.stringify({ name: "f", type: "module", scripts: { test: "node --test" } }), "tests/unit.test.ts": `import { api } from "../src/server/api.js";\nimport test from "node:test";\ntest("api", () => {});\n` });
      execSync("git add -A && git commit -qm base", { cwd: dir });
      const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      write({ "src/client/run.ts": "export const run = 2;" });
      execSync("git commit -qam head", { cwd: dir });
      const head = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      const delta = await analyzeGitDelta({ repoPath: dir, baseSha: base, headSha: head });
      assert.ok(delta.success);
      const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
      const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
      assert.ok(impact.affectedTests.some((t) => t.path === "tests/cli.test.ts"), JSON.stringify(impact.affectedTests.map((t) => t.path)));
      assert.ok(!impact.affectedTests.some((t) => t.path === "tests/unit.test.ts"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
