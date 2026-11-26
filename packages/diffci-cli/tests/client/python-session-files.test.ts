import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { canHandOffNox, readPythonSessionFile, withSessionEnvironment } from "../../src/client/python-session-files.js";

test("session discovery reads bounded regular files and declines runner overrides", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "diffci-session-inputs-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const config = join(repo, "noxfile.py");
  const read = (env: NodeJS.ProcessEnv = {}) => readPythonSessionFile(repo, "noxfile.py", env);
  writeFileSync(config, "import nox\n");
  assert.equal(read({ NOX_CURRENT_SESSION: "lint" }), "import nox\n");
  assert.equal(read({ NOXSESSION: "lint" }), undefined);
  assert.equal(read({ NOX_DEFAULT_VENV_BACKEND: "none" }), undefined);
  assert.equal(read({ PATH: `.${delimiter}${repo}` }), undefined);
  assert.equal(read({ PATH: `${repo}${delimiter}` }), undefined);
  if (process.platform === "win32") {
    writeFileSync(join(repo, "ruff.cmd"), "");
    assert.equal(read({ PATH: repo, PATHEXT: ".CMD" }), undefined);
    rmSync(join(repo, "ruff.cmd"));
  }
  for (const key of ["RUFF_OUTPUT_FILE", "RUFF_CACHE_DIR", "MYPY_CACHE_DIR", "MYPYPATH", "MYPY_TEST_PREFIX"]) {
    assert.equal(read({ [key]: "somewhere" }), undefined);
  }
  assert.equal(read({ RUFF_OUTPUT_FORMAT: "concise", MYPY_FORCE_COLOR: "0" }), "import nox\n");
  if (process.getuid && process.getuid() !== 0) {
    chmodSync(config, 0o000);
    try { assert.equal(read(), undefined); } finally { chmodSync(config, 0o600); }
  }
  writeFileSync(config, " ".repeat(64 * 1024 + 1));
  assert.equal(read(), undefined);
  rmSync(config);
  mkdirSync(config);
  assert.equal(read(), undefined);
  if (process.platform !== "win32") {
    rmSync(config, { recursive: true });
    writeFileSync(join(repo, "other.py"), "import nox\n");
    symlinkSync("other.py", config);
    assert.equal(read(), undefined);
    for (const plugin of ["toxfile.py", "☣.py"]) {
      assert.equal(readPythonSessionFile(repo, plugin), undefined);
      symlinkSync("missing.py", join(repo, plugin));
      assert.equal(readPythonSessionFile(repo, plugin), "");
    }
  }
});

test("tox accepts ordinary pyprojects and declines possible alternative configuration", { skip: process.platform === "win32" }, (t) => {
  const parent = mkdtempSync(join(tmpdir(), "diffci-tox-context-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const repo = join(parent, "project");
  mkdirSync(repo);
  writeFileSync(join(repo, "tox.ini"), "[tox]\n");
  writeFileSync(join(repo, "pyproject.toml"), '[project]\nname = "sample"\n');
  const env = { HOME: parent, XDG_CONFIG_HOME: join(parent, "prefs") };
  assert.equal(readPythonSessionFile(repo, "tox.ini", env), "[tox]\n");
  assert.equal(readPythonSessionFile(repo, "tox.ini", { ...env, TOX_OVERRIDE: "any" }), undefined);
  writeFileSync(join(parent, "pyproject.toml"), '[tool.tox]\nlegacy_tox_ini = "[tox]"\n');
  assert.equal(readPythonSessionFile(repo, "tox.ini", env), undefined);
  rmSync(join(parent, "pyproject.toml"));
  mkdirSync(join(env.XDG_CONFIG_HOME, "tox"), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME, "tox/config.ini"), "[tox]\n");
  assert.equal(readPythonSessionFile(repo, "tox.ini", env), undefined);
});

test("Nox uses a fresh private bytecode cache for each execution and removes it afterwards", () => {
  const execute = () => withSessionEnvironment("nox -s lint", (env) => {
    assert.ok(env);
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
    assert.deepEqual(readdirSync(env.PYTHONPYCACHEPREFIX), []);
    return env.PYTHONPYCACHEPREFIX;
  });
  const one = execute();
  const two = execute();
  assert.ok(one && two);
  assert.notEqual(one, two);
  assert.equal(existsSync(one), false);
  assert.equal(existsSync(two), false);
  assert.equal(withSessionEnvironment("make lint", (env) => env), undefined);
});

test("a bare Nox command is handed off only when the checkout has no cached session", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "diffci-nox-handoff-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const cache = join(repo, "__pycache__");
  mkdirSync(cache);
  writeFileSync(join(cache, "other.cpython-312.pyc"), "");
  if (!process.env.PYTHONPYCACHEPREFIX) assert.equal(canHandOffNox(repo), true);
  writeFileSync(join(cache, "noxfile.cpython-312.pyc"), "");
  assert.equal(canHandOffNox(repo), false);
});
