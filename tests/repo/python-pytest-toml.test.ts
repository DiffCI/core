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

  it("puts pytest.toml before .pytest.toml, and both before [tool.pytest] in pyproject.toml", () => {
    const rest = {
      "pyproject.toml": "[tool.pytest]\ntestpaths = [\"pyproject\"]\n",
      "tox.ini": "[tox]\nenvlist = py\n",
      "setup.cfg": "[metadata]\nname = x\n",
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
    // pytest 9 reads [tool.pytest] here, but pytest 8 reads the empty [tool.pytest.ini_options].
    assert.equal(settingsOf({ "pyproject.toml": "[tool.pytest]\ntestpaths = [\"a\"]\n[tool.pytest.ini_options]\n" }).unreadable,
      "pyproject.toml [tool.pytest] is ignored before pytest 9, which reads [tool.pytest.ini_options]");
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

  it("reads indented keys in every TOML pytest table", () => {
    assert.deepEqual(settingsOf({ "pytest.toml": "[pytest]\n  python_files = ['check_*.py']\n\ttestpaths = [\"tests\"]\n" }),
      { ...defaults, pythonFiles: ["check_*.py"], testpaths: ["tests"] });
    assert.deepEqual(settingsOf({ "pyproject.toml": "[tool.pytest]\n  python_files = [\"check_*.py\"]\n" }).pythonFiles, ["check_*.py"]);
    assert.deepEqual(settingsOf({ "pyproject.toml": "[tool.pytest.ini_options]\n  python_files = \"check_*.py\"\n  testpaths = [\"t\"]\n" }),
      { ...defaults, pythonFiles: ["check_*.py"], testpaths: ["t"] });
    assert.equal(settingsOf({ "pytest.toml": "[pytest]\n  testpaths = \"tests\"\n" }).unreadable, "pytest.toml testpaths");
  });

  it("can't read a TOML pytest table with a quoted or dotted key", () => {
    for (const files of <Array<Record<string, string>>>[
      { "pytest.toml": "[pytest]\n\"testpaths\" = [\"tests\"]\n" },
      { "pytest.toml": "[pytest]\n  'python_files' = ['check_*.py']\n" },
      { "pyproject.toml": "[tool.pytest.ini_options]\n\"python_files\" = \"check_*.py\"\n" },
      { "pyproject.toml": "[tool.pytest]\noptions.testpaths = [\"tests\"]\n" },
    ]) assert.match(settingsOf(files).unreadable ?? "", /key DiffCI can't classify$/, JSON.stringify(files));
    // A quoted string inside an array is a value, not a key.
    assert.deepEqual(settingsOf({ "pytest.toml": "[pytest]\ntestpaths = [\n  \"a\",\n  \"b=c\",\n]\n" }).testpaths, ["a", "b=c"]);
  });

  it("reads a pytest table header followed by a comment", () => {
    assert.deepEqual(settingsOf({ "pytest.toml": "[pytest] # selection\npython_files = [\"check_*.py\"]\n" }).pythonFiles, ["check_*.py"]);
    assert.deepEqual(settingsOf({ "pyproject.toml": "[tool.pytest]  # native\ntestpaths = [\"a\"]\n" }).testpaths, ["a"]);
    assert.deepEqual(settingsOf({ "pyproject.toml": "[tool.pytest.ini_options] # ini\ntestpaths = \"b\"\n" }).testpaths, ["b"]);
    assert.deepEqual(settingsOf({ "tox.ini": "[pytest] ; for pytest\ntestpaths = tox\n" }).testpaths, ["tox"]);
    assert.deepEqual(settingsOf({ "setup.cfg": "[tool:pytest] # for pytest\ntestpaths = cfg\n" }).testpaths, ["cfg"]);
  });

  it("can't read a TOML pytest table header written with spaces or quotes", () => {
    for (const files of <Array<Record<string, string>>>[
      { "pytest.toml": "[ pytest ]\ntestpaths = [\"tests\"]\n" },
      { "pyproject.toml": "[tool.\"pytest\"]\ntestpaths = [\"tests\"]\n" },
      { "pyproject.toml": "[tool . pytest . ini_options]\ntestpaths = \"tests\"\n" },
    ]) assert.match(settingsOf(files).unreadable ?? "", /pytest table header DiffCI can't read$/, JSON.stringify(files));
  });

  it("can't read a native config when pytest before 9 would read another file", () => {
    const toml = "[pytest]\ntestpaths = [\"a\"]\n";
    for (const [older, text] of [["pytest.ini", ""], [".pytest.ini", "[pytest]\ntestpaths = b\n"], ["tox.ini", "[pytest]\ntestpaths = b\n"], ["setup.cfg", "[tool:pytest]\n"]] as const) {
      assert.equal(settingsOf({ "pytest.toml": toml, [older]: text }).unreadable, `pytest.toml is ignored before pytest 9, which reads ${older}`);
    }
    assert.equal(settingsOf({ ".pytest.toml": "", "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = \"b\"\n" }).unreadable,
      ".pytest.toml is ignored before pytest 9, which reads pyproject.toml");
    assert.equal(settingsOf({ "pyproject.toml": "[tool.pytest]\ntestpaths = [\"a\"]\n", "setup.cfg": "[tool:pytest]\ntestpaths = b\n" }).unreadable,
      "pyproject.toml is ignored before pytest 9, which reads setup.cfg");
    // Files pytest doesn't take its configuration from don't matter.
    assert.deepEqual(settingsOf({ "pytest.toml": toml, "tox.ini": "[tox]\nenvlist = py\n", "setup.cfg": "[metadata]\nname = x\n" }).testpaths, ["a"]);
  });
});
