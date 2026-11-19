// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { directToolCall, discoverPythonChecks, narrowPythonChecks } from "../../src/planner/python-checks.js";

const reader = (files: Record<string, string>) => (path: string): string | undefined => files[path];
const workflow = (text: string, path = ".github/workflows/style.yml") => [{ path, text }];

// Shaped after langgenius/dify's style workflow and Makefile (2026-11-18).
const DIFY_WORKFLOW = `
jobs:
  python-style:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync
        run: uv sync --project api --dev
      - name: Contracts
        run: uv run --project api --dev python api/dev/lint_response_contracts.py --fail-on-mismatch
      - name: Type check
        run: make type-check-core
      - name: Agent checks
        run: make -C dify-agent check
  web-style:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ./web
    steps:
      - run: vp run lint
`;
const DIFY_FILES = {
  Makefile: [
    ".PHONY: lint type-check-core",
    "lint:",
    "\t@uv run --project api --dev ruff format ./api",
    "\t@uv run --project api --dev ruff check --fix ./api",
    "",
    "type-check-core:",
    "\t@echo \"Running core type checks (pyrefly)...\"",
    "\t@./dev/pyrefly-check-local $(PATH_TO_CHECK)",
    "\t@echo \"done\"",
    "",
    "test:",
    "\t@uv run pytest",
  ].join("\n"),
  "dev/pyrefly-check-local": "#!/usr/bin/env bash\nset -e\nuv run --directory api --dev pyrefly check \"$@\"\n",
  "dify-agent/Makefile": "check: lint-imports\n\tuv run ruff check .\n",
};

describe("discoverPythonChecks", () => {
  it("reads dify's make targets and leaves everything else out", () => {
    const checks = discoverPythonChecks(workflow(DIFY_WORKFLOW), reader(DIFY_FILES));
    assert.deepEqual(checks.map((c) => [c.command, c.kind, c.pythonOnly, c.triggers]), [
      ["make type-check-core", "typecheck", true, ["Makefile", "dev/pyrefly-check-local"]],
      ["make -C dify-agent check", "lint", false, ["dify-agent/Makefile"]],
    ]);
    assert.ok(checks.every((c) => c.decision === "RUN" && c.reason === "run by CI workflow .github/workflows/style.yml"));
  });

  it("never runs a target whose recipe rewrites files", () => {
    const checks = discoverPythonChecks(workflow("jobs:\n  a:\n    steps:\n      - run: make lint\n"), reader(DIFY_FILES));
    assert.deepEqual(checks, []);
  });

  it("ignores targets that are not check-named or not defined", () => {
    const text = "jobs:\n  a:\n    steps:\n      - run: make test\n      - run: make check-missing\n";
    assert.deepEqual(discoverPythonChecks(workflow(text), reader(DIFY_FILES)), []);
  });

  it("reads direct tool calls behind the usual runners", () => {
    const text = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      "          uv run --project api --dev ruff check ./api --output-format=github",
      "          poetry run mypy src",
      "          python -m pyright",
      "          ruff format --check .",
      "          uv run pyrefly check",
    ].join("\n");
    assert.deepEqual(discoverPythonChecks(workflow(text), reader({})).map((c) => [c.command, c.kind, c.pythonOnly]), [
      ["uv run --project api --dev ruff check ./api --output-format=github", "lint", true],
      ["poetry run mypy src", "typecheck", true],
      ["python -m pyright", "typecheck", true],
      ["ruff format --check .", "format", true],
      ["uv run pyrefly check", "typecheck", true],
    ]);
  });

  it("reads the uv directory option in Dify's agent check, directly and in its Make recipe", () => {
    const command = "uv --directory dify-agent run --project . pyrefly check";
    const text = `jobs:\n  agent:\n    steps:\n      - run: ${command}\n      - run: make check\n`;
    const checks = discoverPythonChecks(workflow(text), reader({ Makefile: `check:\n\t${command}\n` }));
    assert.deepEqual(checks.map((c) => [c.command, c.kind, c.pythonOnly]), [
      [command, "typecheck", true], ["make check", "typecheck", true],
    ]);
    for (const [path, decision] of [["dify-agent/main.py", "RUN"], ["dify-agent/uv.toml", "RUN"], ["web/main.ts", "SKIP"]] as const) {
      assert.deepEqual(narrowPythonChecks(checks, [{ path, status: "modified" }]).map((c) => c.decision), [decision, decision]);
    }
    const nested = text.replace("- run:", "- working-directory: api\n        run:");
    assert.deepEqual(discoverPythonChecks(workflow(nested), reader({})), []);
  });

  it("keeps a Make check unconditional when a Make variable supplies part of the uv invocation", () => {
    const files = { Makefile: "check:\n\tuv --directory api run $(CHECK) pyrefly check\n" };
    const checks = discoverPythonChecks(workflow("jobs:\n  a:\n    steps:\n      - run: make check\n"), reader(files));
    assert.equal(checks[0]?.pythonOnly, false);
    assert.equal(narrowPythonChecks(checks, [{ path: "web/main.ts", status: "modified" }])[0]?.decision, "RUN");
  });

  it("reads only supported uv globals with their operands before run", () => {
    const command = "uv --offline --project=./api --no-progress run --frozen ruff check .";
    assert.deepEqual(directToolCall(command), { command, kind: "lint" });
    for (const line of [
      "uv --directory run pyrefly check", "uv --project= run mypy", "uv --directory --offline run mypy",
      "uv --directory ../api run mypy", "uv --directory /api run mypy", "uv --unknown run mypy",
      "uv --offline --offline run mypy", "uv --project=a --project=b run mypy",
      "uv --group dev run mypy", "uv --offline sync", "uv --offline run unknown-check .",
      "uv --offline run ruff format .", "uv --offline run ruff check --fix .",
    ]) assert.equal(directToolCall(line), undefined, line);
  });

  it("leaves out calls that rewrite files, write output or need the shell", () => {
    for (const line of ["ruff check --fix .", "ruff format .", "mypy --install-types src", "mypy src --junit-xml out.xml", "mypy src | tee out", "mypy $SRC", "mypy \"src\""]) {
      assert.equal(directToolCall(line), undefined, line);
    }
  });

  it("adds nothing from blocks that change directory or environment, or from disabled jobs", () => {
    const text = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      "          cd api",
      "          mypy .",
      "      - run: mypy ${{ inputs.path }}",
      "      - if: false",
      "        run: mypy src",
      "  b:",
      "    if: ${{ false }}",
      "    steps:",
      "      - run: mypy src",
    ].join("\n");
    assert.deepEqual(discoverPythonChecks(workflow(text), reader({})), []);
  });

  it("takes make through a step's working directory and drops direct calls there", () => {
    const text = "jobs:\n  a:\n    steps:\n      - working-directory: dify-agent\n        run: |\n          make check\n          mypy .\n";
    assert.deepEqual(discoverPythonChecks(workflow(text), reader(DIFY_FILES)).map((c) => c.command), ["make -C dify-agent check"]);
  });

  it("does not read a script that also calls a JavaScript tool as Python-only", () => {
    const files = { Makefile: "typecheck:\n\t./scripts/types.sh\n", "scripts/types.sh": "mypy src\nnpx tsc --noEmit\n" };
    const [check] = discoverPythonChecks(workflow("jobs:\n  a:\n    steps:\n      - run: make typecheck\n"), reader(files));
    assert.equal(check?.pythonOnly, false);
  });

  it("does not read a recipe that calls make again as Python-only", () => {
    const files = { Makefile: "check:\n\t$(MAKE) mypy\nmypy:\n\tmypy src\n" };
    const [check] = discoverPythonChecks(workflow("jobs:\n  a:\n    steps:\n      - run: make check\n"), reader(files));
    assert.equal(check?.pythonOnly, false);
  });

  it("returns nothing for a workflow that does not parse", () => {
    assert.deepEqual(discoverPythonChecks(workflow("jobs: [unclosed"), reader({})), []);
  });
});

describe("narrowPythonChecks", () => {
  const checks = discoverPythonChecks(workflow(DIFY_WORKFLOW), reader(DIFY_FILES));

  it("skips a Python-only check when only web files changed, and runs the rest", () => {
    const narrowed = narrowPythonChecks(checks, [{ path: "web/app/page.tsx", status: "modified" }]);
    assert.deepEqual(narrowed.map((c) => [c.command, c.decision]), [["make type-check-core", "SKIP"], ["make -C dify-agent check", "RUN"]]);
    assert.match(narrowed[0]!.reason, /no changed Python file/);
    assert.match(narrowed[1]!.reason, /not read as Python-only/);
  });

  it("runs a Python-only check for a Python file, Python configuration or one of its triggers", () => {
    for (const path of ["api/services/app.py", "api/pyproject.toml", "uv.lock", "api/requirements-dev.txt", "dev/pyrefly-check-local", "Makefile", ".github/workflows/style.yml"]) {
      assert.equal(narrowPythonChecks(checks, [{ path, status: "modified" }])[0]!.decision, "RUN", path);
    }
  });
});
