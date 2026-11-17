// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { pythonInterpreter, readPytestSettings, resolvePythonGraph, type PythonFileImports } from "../../src/repo/adapters/python.js";
import { computeAnalysis } from "../../src/git/git-diff.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

// `addopts = -p myplugin` makes pytest import myplugin.py before collecting any test, so a change to it
// reaches every test even though no test imports it.
describe("pytest plugins loaded with -p in addopts", () => {
  it("reads -p plugins from pytest.ini and pyproject.toml, and skips -p no:", () => {
    const ini = readPytestSettings((path) => path === "pytest.ini" ? "[pytest]\naddopts = -p myplugin -ptools.fixtures -p no:cacheprovider --strict-markers\n" : undefined);
    assert.deepEqual(ini.plugins, ["myplugin", "tools.fixtures"]);
    const string = readPytestSettings((path) => path === "pyproject.toml" ? "[tool.pytest.ini_options]\naddopts = \"-p myplugin -q\"\n" : undefined);
    assert.deepEqual(string.plugins, ["myplugin"]);
    const list = readPytestSettings((path) => path === "pyproject.toml" ? "[tool.pytest.ini_options]\naddopts = [\"-p\", \"myplugin\"]\n" : undefined);
    assert.deepEqual(list.plugins, ["myplugin"]);
    const none = readPytestSettings((path) => path === "pytest.ini" ? "[pytest]\naddopts = -q --strict-markers\n" : undefined);
    assert.equal(none.plugins, undefined);
  });

  it("does not read a multi-line pyproject.toml string as an empty one", () => {
    const settings = readPytestSettings((path) => path === "pyproject.toml" ? "[tool.pytest.ini_options]\naddopts = \"\"\"\n  -p myplugin\n\"\"\"\n" : undefined);
    assert.equal(settings.unreadable, "pyproject.toml addopts");
  });

  it("makes every test depend on a first-party plugin, and falls back when one cannot be resolved", () => {
    const files = ["myplugin.py", "tests/test_a.py", "tests/test_b.py"];
    const parsed: Record<string, PythonFileImports> = { "myplugin.py": { imports: [] }, "tests/test_a.py": { imports: [] }, "tests/test_b.py": { imports: [] } };
    const tests = new Set(["tests/test_a.py", "tests/test_b.py"]);
    const settings = { pythonFiles: ["test_*.py"], testpaths: [], pythonpath: [], plugins: ["myplugin", "pytest_cov"] };
    const { edges, blockers } = resolvePythonGraph(files, parsed, settings, tests);
    assert.deepEqual(blockers, []);
    assert.deepEqual(edges, [{ from: "tests/test_a.py", to: "myplugin.py" }, { from: "tests/test_b.py", to: "myplugin.py" }]);
    const missing = resolvePythonGraph(files, parsed, { ...settings, plugins: ["tests.gone"] }, tests);
    assert.deepEqual(missing.blockers, ["Unresolved pytest plugin in addopts: -p tests.gone"]);
  });
});

const interpreter = pythonInterpreter(process.cwd());

describe("pytest -p plugins end to end", { skip: interpreter ? false : "no Python 3 interpreter on PATH" }, () => {
  it("selects the tests when only the plugin changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "diffci-python-plugin-"));
    const files: Record<string, string> = {
      "pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-p myplugin\"\n",
      "myplugin.py": "import pytest\n\n@pytest.fixture\ndef answer():\n    return 42\n",
      "tests/test_a.py": "def test_a(answer):\n    assert answer == 42\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      const changed: ChangedFile[] = [{ path: "myplugin.py", changeType: "modified" }];
      const delta: GitDelta = {
        baseSha: "base", headSha: "head", files: changed, directories: [],
        summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
        analysis: computeAnalysis(changed),
      };
      const result = new ImpactAnalyzer().analyze(delta, graph, graph.profile, { repositoryFiles: new Set(graph.graph.nodes.map((node) => node.path)) });
      assert.equal(result.fallbackRequired, false, result.fallbackReasons.join("; "));
      assert.deepEqual(result.affectedTests.map((test) => test.path), ["tests/test_a.py"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
