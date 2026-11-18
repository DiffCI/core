// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolvePythonGraph, type PythonFileImports } from "../../src/repo/adapters/python.js";

const defaults = { pythonFiles: ["test_*.py", "*_test.py"], testpaths: [], pythonpath: [] };

// pytest's default `prepend` import mode puts the first directory above a test's package on sys.path,
// so `services/api/tests/test_app.py` (in package `tests`) imports `services/api/app.py` as `app`.
describe("Python imports resolve against a package's basedir", () => {
  const files = [
    "services/api/app.py",
    "services/api/tests/__init__.py", "services/api/tests/helpers.py",
    "services/api/tests/unit/__init__.py", "services/api/tests/unit/test_app.py",
    "services/api/tests/test_app.py",
  ];
  const parsed: Record<string, PythonFileImports> = {
    "services/api/app.py": { imports: [] },
    "services/api/tests/__init__.py": { imports: [] },
    "services/api/tests/helpers.py": { imports: [] },
    "services/api/tests/unit/__init__.py": { imports: [] },
    "services/api/tests/unit/test_app.py": { imports: [["app", 0, []], ["tests.helpers", 0, []]] },
    "services/api/tests/test_app.py": { imports: [["app", 0, []]] },
  };
  const tests = new Set(["services/api/tests/test_app.py", "services/api/tests/unit/test_app.py"]);

  it("links a test inside a package to the module beside that package", () => {
    const { edges, blockers } = resolvePythonGraph(files, parsed, defaults, tests);
    assert.deepEqual(blockers, []);
    const from = (file: string) => edges.filter((edge) => edge.from === file).map((edge) => edge.to).sort();
    assert.deepEqual(from("services/api/tests/test_app.py"), ["services/api/app.py"]);
    assert.deepEqual(from("services/api/tests/unit/test_app.py"), ["services/api/app.py", "services/api/tests/__init__.py", "services/api/tests/helpers.py"]);
  });

  it("adds nothing for a package that reaches the repository root", () => {
    const { edges, blockers } = resolvePythonGraph(["__init__.py", "app.py", "test_app.py"], {
      "__init__.py": { imports: [] }, "app.py": { imports: [] }, "test_app.py": { imports: [["app", 0, []]] },
    }, defaults, new Set(["test_app.py"]));
    assert.deepEqual(blockers, []);
    assert.deepEqual(edges, [{ from: "test_app.py", to: "app.py" }]);
  });
});
