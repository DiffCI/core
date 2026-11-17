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

// Declared inputs pick their tests from the graph's known tests, which were collected only while
// iterating profile.tests. pytest and Maven repositories have no JavaScript test locations, so every
// declaration looked stale: "Declared input ... selects no tests; full validation required".
function write(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
}

async function change(files: Record<string, string>, tests: string[]) {
  const dir = join(tmpdir(), `diffci-declared-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(dir, { ...files, "data/model.bin": "a\n", "diffci.json": JSON.stringify({ inputs: [{ files: ["data/model.bin"], tests }] }) });
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, { "data/model.bin": "b\n" });
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
    return { tests: impact.affectedTests.map((t) => t.path).sort(), fallback: impact.fallbackReasons };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a declared input selects pytest tests", async () => {
  const result = await change({
    "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
    "pkg/__init__.py": "",
    "tests/test_model.py": "def test_model():\n    pass\n",
    "tests/test_other.py": "def test_other():\n    pass\n",
  }, ["tests/test_model.py"]);
  assert.deepEqual(result, { tests: ["tests/test_model.py"], fallback: [] });
});

test("a declared input selects Maven tests", async () => {
  const result = await change({
    "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>\n",
    "src/main/java/a/A.java": "package a;\npublic class A {}\n",
    "src/test/java/a/ATest.java": "package a;\npublic class ATest {}\n",
  }, ["src/test/java/**"]);
  assert.deepEqual(result, { tests: ["src/test/java/a/ATest.java"], fallback: [] });
});

test("a declaration matching no test still falls back", async () => {
  const result = await change({
    "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
    "pkg/__init__.py": "",
    "tests/test_model.py": "def test_model():\n    pass\n",
  }, ["tests/test_missing.py"]);
  assert.deepEqual(result.tests, []);
  assert.deepEqual(result.fallback, ["Declared input data/model.bin selects no tests; full validation required"]);
});

test("alwaysRunTests applies to pytest tests", async () => {
  const dir = join(tmpdir(), `diffci-always-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(dir, {
      "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
      "pkg/__init__.py": "",
      "pkg/a.py": "A = 1\n",
      "tests/test_a.py": "from pkg.a import A\n\ndef test_a():\n    assert A\n",
      "tests/test_smoke.py": "def test_smoke():\n    pass\n",
      "diffci.json": JSON.stringify({ alwaysRunTests: ["tests/test_smoke.py"] }),
    });
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, { "pkg/a.py": "A = 2\n" });
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
    assert.deepEqual(impact.affectedTests.map((t) => t.path).sort(), ["tests/test_a.py", "tests/test_smoke.py"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
