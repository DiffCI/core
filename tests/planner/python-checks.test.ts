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

  it("treats uv.toml as Python configuration for plain uv run and other Python checks", () => {
    const text = "jobs:\n  a:\n    steps:\n      - run: uv run mypy\n      - run: python -m pyright\n";
    const direct = discoverPythonChecks(workflow(text), reader({}));
    for (const [path, decision] of [["uv.toml", "RUN"], ["api/uv.toml", "RUN"], ["api/uv.toml.bak", "SKIP"]] as const) {
      assert.deepEqual(narrowPythonChecks(direct, [{ path, status: "modified" }]).map((c) => [c.command, c.decision]), [
        ["uv run mypy", decision], ["python -m pyright", decision],
      ], path);
    }
  });

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

describe("tox and nox workflow checks", () => {
  // mykrok/mykrok's CI selects lint,type in tox.ini. googleads/google-ads-mcp's CI calls
  // nox -s lint with venv_backend="none". The fixtures use preinstalled, read-only tools.
  const tox = [
    "[tox]", "envlist = lint,type", "[testenv]", "skip_install = true",
    "allowlist_externals =", "    ruff", "    mypy",
    "[testenv:lint]", "commands = ruff check --no-fix --no-fix-only --isolated .",
    "[testenv:type]", "commands = mypy --config-file= src",
  ].join("\n");
  const nox = [
    "import nox", '@nox.session(venv_backend="none")', "def lint(session: nox.Session) -> None:",
    '    session.run("ruff", "format", "--check", "--isolated", ".")',
    "@nox.session(python=False)", "def types(session):", "    session.run('mypy', '--config-file=', 'src')",
  ].join("\n");
  const files = { "tox.ini": tox, "noxfile.py": nox };
  const run = (line: string, config: Record<string, string> = files) =>
    discoverPythonChecks(workflow("jobs:\n  checks:\n    steps:\n      - run: " + line), reader(config));

  it("leaves sessions to CI when their workflow sets up Python and installs tools", () => {
    for (const [command, install] of [
      ["tox -e lint,type", "pip install tox tox-uv"],
      ["nox -s lint", "python -m pip install --upgrade pip\n          pip install black nox"],
    ]) {
      const checkout = "jobs:\n  checks:\n    steps:\n      - uses: actions/checkout@v4";
      const setup = "      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'";
      const installStep = "      - run: |\n          " + install;
      const session = "      - run: " + command;
      for (const steps of [[setup], [installStep], [setup, installStep]]) {
        const text = [checkout, ...steps, session].join("\n");
        assert.deepEqual(discoverPythonChecks(workflow(text), reader(files)), []);
      }
      assert.deepEqual(discoverPythonChecks(workflow(checkout + "\n" + session), reader(files)).map((c) => c.command), [command]);
    }
  });

  it("keeps the regular workflow's session when a linked workflow declares the same command", () => {
    for (const command of ["tox -e lint,type", "nox -s lint"]) {
      const text = `jobs:\n  checks:\n    steps:\n      - run: ${command}\n      - run: uv run mypy src`;
      const linked = { path: ".github/workflows/alias.yml", text, canDeclareSessions: false };
      const regular = { path: ".github/workflows/checks.yml", text };
      for (const workflows of [[linked, regular], [regular, linked]]) {
        const checks = discoverPythonChecks(workflows, reader(files));
        assert.deepEqual(checks.filter((c) => c.command === command).map((c) => c.script), [regular.path]);
        assert.deepEqual(checks.filter((c) => c.command === "uv run mypy src").map((c) => c.script), [workflows[0]!.path]);
      }
      const linkedOnly = discoverPythonChecks([linked], reader(files), () => assert.fail("linked workflow requested a session config"));
      assert.deepEqual(linkedOnly.map((c) => c.command), ["uv run mypy src"]);
    }
  });

  it("preserves each explicit selector and classifies the commands it actually selects", () => {
    for (const [command, kind] of [
      ["tox -e lint", "lint"], ["tox -e type", "typecheck"], ["tox -e type,lint", "script"],
      ["nox -s lint", "format"], ["nox -s types", "typecheck"], ["nox -s types lint", "script"],
    ] as const) {
      const checks = run(command);
      assert.deepEqual(checks.map((c) => [c.command, c.kind, c.pythonOnly]), [[command, kind, true]]);
      for (const [path, decision] of [
        ["src/app.py", "RUN"], ["uv.toml", "RUN"], [command.startsWith("tox") ? "tox.ini" : "noxfile.py", "RUN"],
        ["src/.gitignore", "RUN"], [".github/workflows/check.yml", "RUN"], ["README.md", "SKIP"],
      ] as const) {
        assert.equal(narrowPythonChecks(checks, [{ path, status: "modified" }], () => true)[0]?.decision, decision, path);
      }
    }
  });

  it("accounts for runner configuration when narrowing", () => {
    const [check] = run("nox -s lint", { "noxfile.py": nox.replace('"--isolated", ', "") });
    assert.equal(check?.pythonOnly, false);
    assert.equal(narrowPythonChecks([check!], [{ path: "docs/guide.txt", status: "modified" }])[0]?.decision, "RUN");
    assert.deepEqual(run("tox -e type", { "tox.ini": tox.replace("mypy --config-file= src", "mypy src") }), []);
    assert.deepEqual(run("tox -e lint", { "tox.ini": tox.replace(" --no-fix-only", "") }), []);
    const isolated = run("tox -e lint");
    const changes = [{ path: "input.txt", status: "modified" as const }];
    assert.equal(narrowPythonChecks(isolated, changes)[0]?.decision, "RUN");
    assert.equal(narrowPythonChecks(isolated, changes, () => false)[0]?.decision, "RUN");
  });

  it("requires the entire selection, explicit names and the root execution context", () => {
    for (const line of ["tox", "tox -e lint,missing", "tox -e lint,lint", "tox -e lint -- --fix",
      "nox", "nox -s missing lint", "nox -s lint lint", "nox -s lint --extra", "nox -s ${{ matrix.session }}"]) {
      assert.deepEqual(run(line), [], line);
    }
    for (const field of ["working-directory: subdir", "shell: custom", "if: github.ref", "env: {MODE: alternate}", "continue-on-error: true"]) {
      assert.deepEqual(discoverPythonChecks(workflow("jobs:\n  a:\n    steps:\n      - " + field + "\n        run: tox -e type"), reader(files)), []);
    }
    for (const text of [
      "env: {MODE: alternate}\njobs:\n  a:\n    steps:\n      - run: nox -s lint",
      "jobs:\n  a:\n    defaults:\n      run:\n        shell: custom\n    steps:\n      - run: nox -s lint",
      "jobs:\n  a:\n    env: {MODE: local}\n    steps:\n      - run: tox -e lint",
      "jobs:\n  a:\n    steps:\n      - run: |\n          prepare\n          tox -e lint",
      "jobs:\n  a:\n    steps:\n      - run: \"\u00a0nox -s lint\"",
      "jobs:\n  a:\n    steps:\n      - run: echo MODE=local >> $GITHUB_ENV\n      - run: tox -e lint",
      "jobs:\n  a:\n    steps:\n      - run: prepare_config\n      - run: nox -s lint",
      "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with: {path: alternate}\n      - run: tox -e lint",
      "jobs:\n  a:\n    steps:\n      - run: |\n          # ${{ inputs.detail }}\n          nox -s lint",
    ]) assert.deepEqual(discoverPythonChecks(workflow(text), reader(files)), []);
    const checkout = "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - run: tox -e type\n      - run: nox -s lint";
    assert.deepEqual(discoverPythonChecks(workflow(checkout), reader(files)).map((c) => c.command), ["tox -e type", "nox -s lint"]);
    for (const dir of [".", "./", ".\\", "\\.", "", "sub/.."]) {
      const text = `defaults:\n  run:\n    working-directory: '${dir}'\njobs:\n  a:\n    steps:\n      - run: nox -s lint`;
      assert.equal(discoverPythonChecks(workflow(text), reader(files)).length, dir === "." || dir === "./" ? 1 : 0, dir);
    }
  });

  it("declines ambiguous tox configurations, hooks and mixed commands", () => {
    for (const config of [
      tox.replace("skip_install = true", "skip_install = false"), tox.replace("skip_install = true", "deps = mypy"),
      tox.replace("[testenv:type]", "[testenv:type]\ncommands_pre = prepare"),
      tox.replace("[testenv:type]", "[testenv:type]\ncommands_post = finish"),
      tox.replace("[testenv:type]", "[testenv:type]\nchangedir = src"),
      tox.replace("[testenv:type]", "[testenv:type]\nsetenv = MODE=local"),
      tox.replace("envlist =", "requires = plugin\nenvlist ="), tox.replace("mypy --config-file= src", "mypy {posargs:src}"),
      tox.replace("    mypy", "    *"), tox + "\n[testenv:lint]\ncommands = ruff format .",
      tox + "\n    ruff format .", tox.replace("src", "../other"), tox.replace("src", "result.txt"),
    ]) assert.deepEqual(run("tox -e lint,type", { "tox.ini": config }), [], config);
    for (const plugin of ["toxfile.py", "☣.py"]) assert.deepEqual(run("tox -e type", { ...files, [plugin]: "" }), []);
    assert.deepEqual(run("tox -e type", {}), []);
  });

  it("keeps Make script reads independent of session configuration checks", () => {
    const text = "jobs:\n  a:\n    steps:\n      - run: tox -e type\n      - run: make check";
    const repo = { ...files, Makefile: "check:\n\t./toxfile.py\n", "toxfile.py": "#!/usr/bin/env python3\nimport mypy\n" };
    const checks = discoverPythonChecks(workflow(text), reader(repo), reader({ ...files, "toxfile.py": "" }));
    assert.deepEqual(checks.map((c) => [c.command, c.pythonOnly, c.triggers]), [["make check", true, ["Makefile", "toxfile.py"]]]);
    assert.equal(narrowPythonChecks(checks, [{ path: "README.md", status: "modified" }])[0]?.decision, "SKIP");
  });

  it("reads only literal Nox declarations and calls, including the rest of the module", () => {
    const call = '    session.run("ruff", "format", "--check", "--isolated", ".")';
    for (const config of [
      nox.replace('venv_backend="none"', ""), nox.replace(call, call + '\n    session.run("ruff", "format", ".")'),
      nox.replace(call, '    session.install("ruff")\n' + call), nox.replace(call, '    session.chdir("src")\n' + call),
      nox.replace(call, '    session.notify("types")\n' + call), nox.replace(call, '    session.run("ruff", "format --check")'),
      nox.replace(call, '    session.run("ruff", *session.posargs)'), nox.replace("def types(session):", "def lint(session):"),
      nox + "\nconfigure_sessions()", "# coding: latin-1\n" + nox, "# /// script\n# dependencies = ['ruff']\n# ///\n" + nox,
    ]) assert.deepEqual(run("nox -s lint", { "noxfile.py": config }), [], config);
    assert.deepEqual(run("nox -s lint", {}), []);
  });
});
