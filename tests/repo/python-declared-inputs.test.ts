// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { computeAnalysis } from "../../src/git/git-diff.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";
import { pythonInterpreter } from "../../src/repo/adapters/python.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { RepositoryProfile } from "../../src/repo/types.js";

const interpreter = pythonInterpreter(process.cwd());

// A pytest file that reads a data file by name is invisible to the import graph: nothing imports
// `tests/data/prices.csv`, so without a declaration the change falls back to the full suite. This is
// the Python counterpart of the Go testdata case in go-runtime-inputs.test.ts (issue #162).
//
// Declaring this used to select nothing: `declaredTests` looked for candidates in `profile.tests`,
// which only the JavaScript runners fill, so a `tests` glob naming a `test_*.py` file matched
// nothing and the declaration was reported as stale - the fallback it was meant to narrow stayed.
describe("declared inputs for pytest", { skip: interpreter ? false : "no Python 3 interpreter on PATH" }, () => {
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

  function analyze(root: string, graph: Awaited<ReturnType<typeof buildDependencyGraph>>, path: string) {
    const files = [{ path, changeType: "modified" as const }];
    return new ImpactAnalyzer().analyze(delta(files), graph, graph.profile as RepositoryProfile, {
      repositoryFiles: new Set(graph.graph.nodes.map((node) => node.path)),
    });
  }

  const files = {
    "pyproject.toml": "[project]\nname = \"shop\"\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
    "src/shop/__init__.py": "",
    "src/shop/pricing.py": "def total(items):\n    return sum(items)\n",
    "tests/data/prices.csv": "sku,price\napple,1\n",
    "tests/test_prices.py": "import csv\nfrom pathlib import Path\n\ndef test_prices():\n    rows = list(csv.DictReader(Path(__file__).with_name(\"data\").joinpath(\"prices.csv\").open()))\n    assert rows[0][\"sku\"] == \"apple\"\n",
    "tests/test_pricing.py": "from shop.pricing import total\n\ndef test_total():\n    assert total([1, 2]) == 3\n",
  };

  it("selects the test a declaration names when the data file it reads changes", async () => {
    const root = fixture({
      ...files,
      "diffci.json": JSON.stringify({ inputs: [{ files: ["tests/data/**"], tests: ["tests/test_prices.py"] }] }),
    });
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.deepEqual(graph.adapterBlockers ?? [], [], JSON.stringify(graph.adapterBlockers));
      // The adapter did model both test files, so the declaration names a test DiffCI knows about.
      assert.deepEqual(graph.profile.pythonTests, ["tests/test_prices.py", "tests/test_pricing.py"]);
      const analysis = analyze(root, graph, "tests/data/prices.csv");
      const selected = analysis.affectedTests.filter((entry) => entry.path === "tests/test_prices.py");
      assert.equal(selected.length, 1, JSON.stringify({ tests: analysis.affectedTests, fallback: analysis.fallbackReasons }));
      assert.ok(selected[0]!.reasons.includes("DECLARED_INPUT"), JSON.stringify(selected[0]));
      // The declaration stands in for the full-suite fallback an unread data file would cause.
      assert.equal(analysis.fallbackRequired, false, analysis.fallbackReasons.join("; "));
      assert.ok(!analysis.affectedTests.some((entry) => entry.path === "tests/test_pricing.py"), "the other test must stay out");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back for a data file nothing declares", async () => {
    const root = fixture(files);
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      const analysis = analyze(root, graph, "tests/data/prices.csv");
      assert.equal(analysis.fallbackRequired, true, "an unread data file must still run everything");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
