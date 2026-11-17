// SPDX-License-Identifier: MIT
// A program the test script runs itself (`node scripts/check.mjs && node --test`) is part of the suite.
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { repositoryFileReader, testScriptPrograms } from "../../src/repo/file-references.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(a(), 1));\n";

function repository(test: string, tsconfig = true): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "x", type: "module", scripts: { test } }),
    ...(tsconfig ? { "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true, module: "nodenext", noEmit: true }, include: ["src", "test", "scripts"] }) } : {}),
    "src/a.js": "export const a = () => 1;\n",
    "test/a.test.js": TEST,
    "scripts/lib.mjs": "export const ok = true;\n",
    "scripts/check.mjs": "import { ok } from './lib.mjs';\nif (!ok) process.exit(1);\n",
    "scripts/release.mjs": "console.log('release');\n",
  };
}

async function analyze(base: Record<string, string>, change: Record<string, string>, selectTestPhases = false) {
  const dir = join(tmpdir(), `diffci-test-script-programs-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(dir, base);
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, change);
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    return new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, {
      repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir), selectTestPhases,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BROKEN = { "scripts/check.mjs": "console.error('data broken');\nprocess.exit(1);\n" };

describe("a program the test script runs directly", () => {
  it("falls back when it changes", async () => {
    const impact = await analyze(repository("node scripts/check.mjs && node --test"), BROKEN);
    assert.match(impact.fallbackReasons.join("\n"), /test script runs scripts\/check\.mjs/);
  });

  it("falls back when it runs after the test runner, or is reached through another script", async () => {
    const after = await analyze(repository("node --test && node scripts/check.mjs"), BROKEN);
    assert.match(after.fallbackReasons.join("\n"), /test script runs scripts\/check\.mjs/);
    const base = repository("npm run check && node --test");
    const viaScript = await analyze({ ...base, "package.json": JSON.stringify({ name: "x", type: "module", scripts: { test: "npm run check && node --test", check: "node scripts/check.mjs" } }) }, BROKEN);
    assert.match(viaScript.fallbackReasons.join("\n"), /test script runs scripts\/check\.mjs/);
  });

  it("falls back when code it imports changes", async () => {
    const impact = await analyze(repository("node scripts/check.mjs && node --test"), { "scripts/lib.mjs": "export const ok = false;\n" });
    assert.match(impact.fallbackReasons.join("\n"), /test script runs scripts\/check\.mjs, which imports scripts\/lib\.mjs/);
  });

  it("falls back without a tsconfig that includes it", async () => {
    const impact = await analyze(repository("node scripts/check.mjs && node --test", false), BROKEN);
    assert.match(impact.fallbackReasons.join("\n"), /test script runs scripts\/check\.mjs/);
  });

  it("is run as a test-script phase for callers that run phases", async () => {
    const impact = await analyze(repository("node scripts/check.mjs && node --test"), BROKEN, true);
    assert.deepEqual(impact.fallbackReasons, []);
    assert.deepEqual(impact.testPhases, ["node scripts/check.mjs"]);
  });

  it("still selects nothing for a script the test script does not run", async () => {
    const impact = await analyze(repository("node scripts/check.mjs && node --test"), { "scripts/release.mjs": "console.log('release 2');\n" });
    assert.deepEqual(impact.fallbackReasons, []);
    assert.deepEqual(impact.testPhases, undefined);
  });

  it("still selects the tests of a source change", async () => {
    const impact = await analyze(repository("node scripts/check.mjs && node --test"), { "src/a.js": "export const a = () => 1; // edit\n" });
    assert.deepEqual(impact.fallbackReasons, []);
    assert.deepEqual(impact.affectedTests.map((test) => test.path), ["test/a.test.js"]);
  });
});

describe("testScriptPrograms", () => {
  it("finds the programs the test closure runs with an interpreter, and which phases can run alone", () => {
    const programs = testScriptPrograms({
      pretest: "node ./scripts/a.mjs",
      test: "npm run lint && tsx --import ./setup.mjs scripts/b.ts && node --test && node -e \"1\" && node scripts/c.mjs --strict",
      lint: "node scripts/d.mjs || true",
      posttest: "npx tsx scripts/e.ts",
      release: "node scripts/release.mjs",
    });
    assert.deepEqual(Object.fromEntries(programs), {
      "scripts/a.mjs": { phases: ["node ./scripts/a.mjs"], direct: true },
      "scripts/b.ts": { phases: ["tsx --import ./setup.mjs scripts/b.ts"], direct: true },
      "scripts/c.mjs": { phases: ["node scripts/c.mjs --strict"], direct: false },
      "scripts/d.mjs": { phases: ["node scripts/d.mjs"], direct: false },
      "scripts/e.ts": { phases: ["npx tsx scripts/e.ts"], direct: false },
    });
  });
});
