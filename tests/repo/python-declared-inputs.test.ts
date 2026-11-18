// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { computeAnalysis } from "../../src/git/git-diff.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import { pythonInterpreter } from "../../src/repo/adapters/python.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

const pythonAvailable = pythonInterpreter(process.cwd()) !== undefined;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-python-inputs-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function delta(files: ChangedFile[]): GitDelta {
  return {
    baseSha: "base", headSha: "head", files, directories: [],
    summary: { total: files.length, added: 0, modified: files.length, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: computeAnalysis(files),
  };
}

// A pytest test that loads a data file by name, which the import graph can't see (#162).
const files = {
  "pyproject.toml": "[project]\nname = \"shop\"\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
  "src/shop/__init__.py": "",
  "src/shop/pricing.py": "def total(items):\n    return sum(items)\n",
  "tests/data/prices.csv": "item,price\napple,1\n",
  "tests/test_prices.py": "import csv\n\ndef test_prices():\n    with open(\"tests/data/prices.csv\") as handle:\n        assert list(csv.DictReader(handle))\n",
  "tests/test_pricing.py": "from shop.pricing import total\n\ndef test_total():\n    assert total([1, 2]) == 3\n",
};

describe("declared inputs in a pytest repository (#162)", { skip: pythonAvailable ? false : "no Python 3 interpreter on PATH" }, () => {
  it("selects the test a declared data file maps to, with reason DECLARED_INPUT", async () => {
    const root = fixture({ ...files, "diffci.json": JSON.stringify({ inputs: [{ files: ["tests/data/**"], tests: ["tests/test_prices.py"] }] }) });
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.deepEqual(graph.adapterBlockers ?? [], [], JSON.stringify(graph.adapterBlockers));
      const impact = new ImpactAnalyzer().analyze(delta([{ path: "tests/data/prices.csv", changeType: "modified" }]), graph, graph.profile, { repositoryFiles: new Set(Object.keys(files)) });
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("; "));
      assert.deepEqual(impact.affectedTests.map((test) => test.path), ["tests/test_prices.py"]);
      assert.ok(impact.affectedTests[0]!.reasons.includes("DECLARED_INPUT"), JSON.stringify(impact.affectedTests));
      const plan = planSelectiveTestCommands(graph.profile, impact.affectedTests.map((test) => test.path));
      assert.deepEqual(plan.commands[0]?.args.slice(-3), ["-m", "pytest", "tests/test_prices.py"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("runs the full suite for the same change without the declaration", async () => {
    const root = fixture(files);
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      const impact = new ImpactAnalyzer().analyze(delta([{ path: "tests/data/prices.csv", changeType: "modified" }]), graph, graph.profile, { repositoryFiles: new Set(Object.keys(files)) });
      assert.equal(impact.fallbackRequired, true);
      assert.ok(impact.fallbackReasons.some((reason) => reason.includes("tests/data/prices.csv")), impact.fallbackReasons.join("; "));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
