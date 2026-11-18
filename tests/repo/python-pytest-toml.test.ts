// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isPytestFile, pythonAdapter, readPytestSettings } from "../../src/repo/adapters/python.js";
import { computeAnalysis } from "../../src/git/git-diff.js";

const defaults = { pythonFiles: ["test_*.py", "*_test.py"], testpaths: [], pythonpath: [] };
const settingsOf = (files: Record<string, string>) => readPytestSettings((path) => files[path]);

describe("pytest 9 pytest.toml and [tool.pytest] (#160)", () => {
  it("reads the [pytest] table of pytest.toml and .pytest.toml in native TOML mode", () => {
    const toml = settingsOf({ "pytest.toml": "[pytest]\npython_files = [\"check_*.py\"]\ntestpaths = [\"tests\"]\npythonpath = [\"src\"]\naddopts = [\"-p\", \"myplugin\", \"-ptools.fixtures\", \"-p\", \"no:cacheprovider\"]\n" });
    assert.deepEqual(toml, { pythonFiles: ["check_*.py"], testpaths: ["tests"], pythonpath: ["src"], plugins: ["myplugin", "tools.fixtures"] });
    assert.ok(isPytestFile("tests/check_a.py", toml));
    assert.ok(!isPytestFile("tests/test_a.py", toml));
    assert.deepEqual(settingsOf({ ".pytest.toml": "[pytest]\ntestpaths = [\"integration\"]\n" }).testpaths, ["integration"]);
  });

  it("puts pytest.toml before .pytest.toml, and both before pytest.ini, pyproject.toml, tox.ini and setup.cfg", () => {
    const rest = {
      "pytest.ini": "[pytest]\ntestpaths = ini\n",
      ".pytest.ini": "[pytest]\ntestpaths = hidden-ini\n",
      "pyproject.toml": "[tool.pytest]\ntestpaths = [\"pyproject\"]\n",
      "tox.ini": "[pytest]\ntestpaths = tox\n",
      "setup.cfg": "[tool:pytest]\ntestpaths = cfg\n",
    };
    assert.deepEqual(settingsOf({ "pytest.toml": "[pytest]\ntestpaths = [\"a\"]\n", ".pytest.toml": "[pytest]\ntestpaths = [\"b\"]\n", ...rest }).testpaths, ["a"]);
    assert.deepEqual(settingsOf({ ".pytest.toml": "[pytest]\ntestpaths = [\"b\"]\n", ...rest }).testpaths, ["b"]);
  });

  it("stops at a pytest.toml that is empty or has no [pytest] table", () => {
    const pyproject = "[tool.pytest]\npython_files = [\"check_*.py\"]\n";
    assert.deepEqual(settingsOf({ "pytest.toml": "", "pyproject.toml": pyproject }), defaults);
    assert.deepEqual(settingsOf({ ".pytest.toml": "# configured elsewhere\n[tool.other]\nx = 1\n", "pyproject.toml": pyproject }), defaults);
  });

  it("can't read options written above the [pytest] table, which pytest rejects", () => {
    assert.equal(settingsOf({ "pytest.toml": "testpaths = [\"tests\"]\n" }).unreadable, "pytest.toml options outside [pytest]");
  });

  it("reads [tool.pytest] in pyproject.toml without mistaking it for [tool.pytest.ini_options]", () => {
    const native = settingsOf({ "pyproject.toml": "[project]\nname = \"x\"\n[tool.pytest]\npython_files = [\"check_*.py\"]\n[tool.ruff]\nline-length = 100\n" });
    assert.deepEqual(native, { ...defaults, pythonFiles: ["check_*.py"] });
    const ini = settingsOf({ "pyproject.toml": "[tool.pytest.ini_options]\npython_files = \"check_*.py\"\n" });
    assert.deepEqual(ini.pythonFiles, ["check_*.py"]);
  });

  it("can't read a native value that isn't a list of strings", () => {
    assert.equal(settingsOf({ "pyproject.toml": "[tool.pytest]\ntestpaths = \"tests\"\n" }).unreadable, "pyproject.toml testpaths");
    assert.equal(settingsOf({ "pytest.toml": "[pytest]\npython_files = [1]\n" }).unreadable, "pytest.toml python_files");
    assert.equal(settingsOf({ "pytest.toml": "[pytest]\naddopts = \"-p myplugin\"\n" }).unreadable, "pytest.toml addopts");
  });

  it("can't read a pyproject.toml with both tables, which pytest refuses", () => {
    const both = settingsOf({ "pyproject.toml": "[tool.pytest]\ntestpaths = [\"a\"]\n[tool.pytest.ini_options]\ntestpaths = [\"b\"]\n" });
    assert.equal(both.unreadable, "pyproject.toml [tool.pytest] and [tool.pytest.ini_options]");
    assert.equal(settingsOf({ "pyproject.toml": "[tool.pytest]\nini_options.testpaths = [\"b\"]\n" }).unreadable, "pyproject.toml [tool.pytest] ini_options");
  });

  it("uses whichever pyproject.toml table has options when the other is empty", () => {
    assert.deepEqual(settingsOf({ "pyproject.toml": "[tool.pytest]\ntestpaths = [\"a\"]\n[tool.pytest.ini_options]\n" }).testpaths, ["a"]);
    assert.deepEqual(settingsOf({ "pyproject.toml": "[tool.pytest]\n# nothing yet\n[tool.pytest.ini_options]\ntestpaths = \"b\"\n" }).testpaths, ["b"]);
    assert.deepEqual(settingsOf({ "pyproject.toml": "[tool.pytest]\n", "tox.ini": "[pytest]\ntestpaths = tox\n" }).testpaths, ["tox"]);
  });

  it("detects pytest.toml projects and falls back when pytest.toml or .pytest.toml changes", () => {
    assert.ok(pythonAdapter.detect({ files: ["pytest.toml", "test_a.py"] } as never));
    assert.ok(pythonAdapter.detect({ files: [".pytest.toml", "test_a.py"] } as never));
    for (const path of ["pytest.toml", ".pytest.toml"]) {
      assert.equal(computeAnalysis([{ path, changeType: "modified" }]).configChanged, true, path);
    }
    assert.equal(computeAnalysis([{ path: "docs/pytest.toml", changeType: "modified" }]).configChanged, false);
  });
});
