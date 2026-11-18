// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isPytestFile } from "../../src/repo/adapters/python.js";

// pytest expands every `testpaths` entry with glob.iglob(entry, recursive=True), so
// `testpaths = ["pkgs/*/tests"]` collects pkgs/a/tests/test_lib.py.
describe("pytest testpaths with shell-style wildcards", () => {
  const settings = (testpaths: string[]) => ({ pythonFiles: ["test_*.py", "*_test.py"], testpaths, pythonpath: [] });

  it("matches test files under a directory a wildcard names", () => {
    const globbed = settings(["tests", "pkgs/*/tests"]);
    assert.ok(isPytestFile("tests/test_t.py", globbed));
    assert.ok(isPytestFile("pkgs/a/tests/test_lib.py", globbed));
    assert.ok(isPytestFile("pkgs/a/tests/unit/test_lib.py", globbed));
    assert.ok(!isPytestFile("pkgs/a/b/tests/test_lib.py", globbed), "* does not span directories");
    assert.ok(!isPytestFile("pkgs/a/test_lib.py", globbed));
  });

  it("follows ** at any depth, ? and character classes", () => {
    assert.ok(isPytestFile("services/api/tests/test_x.py", settings(["**/tests"])));
    assert.ok(isPytestFile("tests/test_x.py", settings(["**/tests"])));
    assert.ok(isPytestFile("pkg1/tests/test_x.py", settings(["pkg?/tests"])));
    assert.ok(isPytestFile("pkg1/tests/test_x.py", settings(["pkg[0-9]/tests"])));
    assert.ok(!isPytestFile("pkgx/tests/test_x.py", settings(["pkg[!x]/tests"])));
    assert.ok(isPytestFile("pkgs/a/tests/test_lib.py", settings(["pkgs/*/tests/test_*.py"])), "a glob may name files");
  });

  it("keeps plain testpaths as directory prefixes", () => {
    assert.ok(isPytestFile("tests/test_t.py", settings(["tests"])));
    assert.ok(!isPytestFile("tests2/test_t.py", settings(["tests"])));
  });
});
