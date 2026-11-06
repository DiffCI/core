// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { isPytestFile, pythonAdapter, pythonInterpreter, readPytestSettings, resolvePythonGraph, type PythonFileImports } from "../../src/repo/adapters/python.js";
import { computeAnalysis } from "../../src/git/git-diff.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";
import { buildDependencyGraph, classifyRepositoryProject } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";

const defaults = { pythonFiles: ["test_*.py", "*_test.py"], testpaths: [], pythonpath: [] };

describe("Python import resolution (2026-11-06)", () => {
  const files = [
    "src/shop/__init__.py", "src/shop/cart.py", "src/shop/pricing/__init__.py", "src/shop/pricing/tax.py",
    "tests/conftest.py", "tests/helpers.py", "tests/test_cart.py", "tests/unit/test_tax.py", "conftest.py",
  ];
  const parsed: Record<string, PythonFileImports> = {
    "src/shop/__init__.py": { imports: [] },
    "src/shop/cart.py": { imports: [["pricing.tax", 1, ["rate"]], ["json", 0, []]] },
    "src/shop/pricing/__init__.py": { imports: [] },
    "src/shop/pricing/tax.py": { imports: [] },
    "tests/conftest.py": { imports: [["pytest", 0, []]] },
    "tests/helpers.py": { imports: [] },
    "tests/test_cart.py": { imports: [["shop.cart", 0, ["Cart"]], ["helpers", 0, []]] },
    "tests/unit/test_tax.py": { imports: [["shop.pricing", 0, ["tax"]]] },
    "conftest.py": { imports: [] },
  };
  const tests = new Set(["tests/test_cart.py", "tests/unit/test_tax.py"]);

  it("resolves absolute, relative, package and from-imports, with the parents' __init__.py", () => {
    const { edges, blockers } = resolvePythonGraph(files, parsed, defaults, tests);
    assert.deepEqual(blockers, []);
    const from = (file: string) => edges.filter((edge) => edge.from === file).map((edge) => edge.to).sort();
    assert.deepEqual(from("src/shop/cart.py"), ["src/shop/pricing/__init__.py", "src/shop/pricing/tax.py"]);
    assert.deepEqual(from("tests/test_cart.py"), ["conftest.py", "src/shop/__init__.py", "src/shop/cart.py", "tests/conftest.py", "tests/helpers.py"]);
    assert.deepEqual(from("tests/unit/test_tax.py"), ["conftest.py", "src/shop/__init__.py", "src/shop/pricing/__init__.py", "src/shop/pricing/tax.py", "tests/conftest.py"]);
  });

  it("falls back on computed imports, unparsable files and unresolved first-party modules, not on third-party ones", () => {
    const { blockers } = resolvePythonGraph(files, {
      ...parsed,
      "src/shop/cart.py": { imports: [["shop.gone", 0, []], ["requests", 0, []]], dynamic: true },
      "tests/helpers.py": { error: "SyntaxError" },
    }, defaults, tests);
    assert.ok(blockers.some((b) => /computed import in src\/shop\/cart\.py/.test(b)));
    assert.ok(blockers.some((b) => /could not be parsed \(SyntaxError\): tests\/helpers\.py/.test(b)));
    assert.ok(blockers.some((b) => /Unresolved first-party Python import in src\/shop\/cart\.py: shop\.gone/.test(b)));
    assert.ok(!blockers.some((b) => /requests/.test(b)));
  });
});

describe("pytest settings", () => {
  it("reads python_files, testpaths and pythonpath from pytest.ini or pyproject.toml", () => {
    const ini = readPytestSettings((path) => path === "pytest.ini" ? "[pytest]\npython_files = check_*.py\n    *_spec.py\ntestpaths = tests\n" : undefined);
    assert.deepEqual(ini, { pythonFiles: ["check_*.py", "*_spec.py"], testpaths: ["tests"], pythonpath: [] });
    const toml = readPytestSettings((path) => path === "pyproject.toml" ? "[project]\nname='x'\n[tool.pytest.ini_options]\ntestpaths = [\"tests\", \"integration\"]\npythonpath = \"lib\"\n" : undefined);
    assert.deepEqual(toml, { pythonFiles: ["test_*.py", "*_test.py"], testpaths: ["tests", "integration"], pythonpath: ["lib"] });
    assert.equal(readPytestSettings((path) => path === "pyproject.toml" ? "[tool.pytest.ini_options]\npython_files = some_function()\n" : undefined).unreadable, "pyproject.toml python_files");
    assert.ok(isPytestFile("tests/test_a.py", toml));
    assert.ok(!isPytestFile("scripts/test_a.py", toml));
    assert.ok(!isPytestFile("tests/helpers.py", toml));
  });
});

const interpreter = pythonInterpreter(process.cwd());

describe("Python repositories end to end", { skip: interpreter ? false : "no Python 3 interpreter on PATH" }, () => {
  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "diffci-python-"));
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

  it("selects the pytest files a change reaches and runs them with the interpreter it found", async () => {
    const root = fixture({
      "pyproject.toml": "[project]\nname = \"shop\"\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
      "src/shop/__init__.py": "",
      "src/shop/cart.py": "from .pricing import total\n\nclass Cart:\n    pass\n",
      "src/shop/pricing.py": "def total(items):\n    return sum(items)\n",
      "src/shop/emails.py": "import smtplib\n",
      "tests/test_cart.py": "from shop.cart import Cart\n\ndef test_cart():\n    assert Cart\n",
      "tests/test_pricing.py": "from shop.pricing import total\n\ndef test_total():\n    assert total([1, 2]) == 3\n",
      "tests/test_emails.py": "import shop.emails\n\ndef test_emails():\n    pass\n",
    });
    try {
      assert.deepEqual(classifyRepositoryProject(root), { capable: true, reason: "Python project tested with pytest (file-level import analysis)" });
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.deepEqual(graph.adapterBlockers ?? [], [], JSON.stringify(graph.adapterBlockers));
      assert.deepEqual(graph.profile.pythonTests, ["tests/test_cart.py", "tests/test_emails.py", "tests/test_pricing.py"]);
      const analyze = (files: ChangedFile[]) => new ImpactAnalyzer().analyze(delta(files), graph, graph.profile, { repositoryFiles: new Set(graph.graph.nodes.map((node) => node.path)) });

      const pricing = analyze([{ path: "src/shop/pricing.py", changeType: "modified" }]);
      assert.equal(pricing.fallbackRequired, false, pricing.fallbackReasons.join("; "));
      assert.deepEqual(pricing.affectedTests.map((t) => t.path), ["tests/test_cart.py", "tests/test_pricing.py"]);
      const plan = planSelectiveTestCommands(graph.profile, pricing.affectedTests.map((t) => t.path));
      assert.deepEqual(plan.commands, [{ executable: interpreter![0], args: [...interpreter!.slice(1), "-m", "pytest", "tests/test_cart.py", "tests/test_pricing.py"] }]);

      const emails = analyze([{ path: "src/shop/emails.py", changeType: "modified" }]);
      assert.deepEqual(emails.affectedTests.map((t) => t.path), ["tests/test_emails.py"]);

      const project = analyze([{ path: "pyproject.toml", changeType: "modified" }]);
      assert.equal(project.fallbackRequired, true, "a changed pyproject.toml runs everything");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still selects a JavaScript test that runs a Python script by name", async () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "mixed", devDependencies: { vitest: "^3.0.0" }, scripts: { test: "vitest run" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src", "test"] }),
      "pyproject.toml": "[tool.ruff]\nline-length = 100\n",
      "src/index.ts": "export const one = 1;\n",
      "test/build.test.ts": "import { execFileSync } from 'node:child_process';\nimport { test } from 'vitest';\ntest('build', () => { execFileSync('python', ['scripts/build.py']); });\n",
      "scripts/build.py": "print('built')\n",
    });
    try {
      const graph = await buildDependencyGraph({ repoPath: root });
      const files = new Set([...graph.graph.nodes.map((node) => node.path), "test/build.test.ts", "scripts/build.py", "package.json"]);
      const read = (path: string) => { try { return readFileSync(join(root, path), "utf8"); } catch { return undefined; } };
      const result = new ImpactAnalyzer().analyze(delta([{ path: "scripts/build.py", changeType: "modified" }]), graph, graph.profile, { repositoryFiles: files, readRepositoryFile: read });
      assert.ok(result.affectedTests.some((t) => t.path === "test/build.test.ts"), JSON.stringify({ tests: result.affectedTests.map((t) => t.path), fallback: result.fallbackReasons }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not claim a JavaScript repository with a stray Python script", () => {
    assert.equal(pythonAdapter.detect({ repoPath: ".", files: ["package.json", "tsconfig.json", "src/a.ts", "scripts/train.py"], profile: {} as never }), false);
  });
});
