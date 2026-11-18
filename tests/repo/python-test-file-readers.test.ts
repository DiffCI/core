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

// A pytest test that reads a data file was followed as a script, because .py is not a JavaScript source
// extension. Nothing names the test, so the change selected nothing and did not fall back.
function write(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
}

async function change(files: Record<string, string>, path: string) {
  const dir = join(tmpdir(), `diffci-py-readers-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(dir, { "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n", "pkg/__init__.py": "", "tests/test_other.py": "def test_other():\n    pass\n", ...files });
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, { [path]: "changed\n" });
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: [".git"] });
    const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
    return { tests: impact.affectedTests.map((t) => t.path).sort(), fallback: impact.fallbackReasons };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a data file read by a pytest test selects that test", async () => {
  const result = await change({
    "tests/data/prices.csv": "a,b\n",
    "tests/test_prices.py": "from pathlib import Path\n\ndef test_prices():\n    assert (Path(__file__).parent / \"data\" / \"prices.csv\").read_text()\n",
  }, "tests/data/prices.csv");
  assert.deepEqual(result, { tests: ["tests/test_prices.py"], fallback: [] });
});

test("a data file read by a helper selects the tests that import it", async () => {
  const result = await change({
    "data/rates.json": "{}\n",
    "pkg/rates.py": "import json\nfrom pathlib import Path\n\ndef load():\n    return json.loads((Path(__file__).parent.parent / \"data\" / \"rates.json\").read_text())\n",
    "tests/test_rates.py": "from pkg.rates import load\n\ndef test_rates():\n    assert load() == {}\n",
  }, "data/rates.json");
  assert.deepEqual(result, { tests: ["tests/test_rates.py"], fallback: [] });
});

test("a data file nothing reads still falls back", async () => {
  const result = await change({ "data/unused.json": "{}\n" }, "data/unused.json");
  assert.deepEqual(result.tests, []);
  assert.ok(result.fallback.length > 0);
});
