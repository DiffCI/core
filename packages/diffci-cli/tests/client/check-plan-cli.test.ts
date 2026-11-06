import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "dist-client", "src", "client", "cli.js");

before(() => {
  const build = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.client.json"], { cwd: ROOT, encoding: "utf8" });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stdout + build.stderr);
});

function selection(mode: "SELECTIVE" | "FULL" = "SELECTIVE") {
  return {
    version: "5.0.0",
    mode,
    selectedTests: ["tests/selected.test.ts"],
    skippedTests: mode === "SELECTIVE" ? ["tests/skipped.test.ts"] : [],
    safety: { fallbackRequired: mode === "FULL" },
  };
}

function failure(file?: string): string {
  return `<testcase name="fails"${file === undefined ? "" : ` file="${file}"`}><failure message="assertion failed"/></testcase>`;
}

function junit(...cases: string[]): string {
  return `<testsuites><testsuite name="suite">${cases.join("")}</testsuite></testsuites>`;
}

function fixture(body: (directory: string, planPath: string, resultsPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "diffci-check-plan-"));
  const planPath = join(directory, "plan with spaces.json");
  const resultsPath = join(directory, "results with spaces.xml");
  try {
    writeFileSync(planPath, JSON.stringify(selection()));
    writeFileSync(resultsPath, junit(failure("tests/selected.test.ts")));
    body(directory, planPath, resultsPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run(directory: string, args: string[], preload?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [...(preload ? ["--require", preload] : []), CLI, "check-plan", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env,
  });
}

function invalid(directory: string, args: string[]): void {
  const result = run(directory, args);
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr);
  assert.equal(error.schemaVersion, 1);
  assert.equal(typeof error.error, "string");
  assert.ok(error.error.length > 0);
}

describe("check-plan CLI", () => {
  it("reports all three failure groups and exits nonzero for misses or unattributed failures", () => {
    fixture((directory, planPath, resultsPath) => {
      writeFileSync(resultsPath, junit(failure("tests/selected.test.ts"), failure("tests/skipped.test.ts"), failure()));
      const result = run(directory, ["--plan", planPath, "--results", resultsPath]);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.mode, "SELECTIVE");
      assert.equal(report.fullFallback, false);
      assert.deepEqual(report.summary, { failedTests: 3, missed: 0, preExisting: 0, possibleMisses: 1, selected: 1, unattributed: 1 });
      assert.equal(report.possibleMisses.length, 1);
      assert.equal(report.selected.length, 1);
      assert.equal(report.unattributed.length, 1);
    });
  });

  it("accepts the Core CLI wrapper and reversed flag order without requiring a Git checkout", () => {
    fixture((directory, planPath, resultsPath) => {
      writeFileSync(planPath, JSON.stringify({ advisoryOnly: true, base: "base-revision", head: "same-revision", plan: selection() }));
      const result = run(directory, ["--results", resultsPath, "--plan", planPath]);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout).summary, { failedTests: 1, missed: 0, preExisting: 0, possibleMisses: 0, selected: 1, unattributed: 0 });
    });
  });

  it("compares captured Vitest and jest-junit reports through the public command", () => {
    fixture((directory, planPath, resultsPath) => {
      writeFileSync(planPath, JSON.stringify({
        ...selection(),
        selectedTests: ["tests/pass.test.js"],
        skippedTests: ["tests/hook-error.test.js", "tests/load-error.test.js", "tests/multiple-errors.test.js", "tests/space & failure.test.js"],
      }));
      for (const [file, missed, unattributed] of [
        ["vitest-default.xml", 5, 0], ["vitest-explicit.xml", 5, 0],
        ["jest-junit-default.xml", 0, 4], ["jest-junit-explicit.xml", 6, 0],
      ] as const) {
        writeFileSync(resultsPath, readFileSync(join(ROOT, "tests/client/fixtures/check-plan", file)));
        const result = run(directory, ["--plan", planPath, "--results", resultsPath]);
        assert.ifError(result.error);
        assert.equal(result.status, 1, `${file}: ${result.stdout}${result.stderr}`);
        assert.equal(result.stderr, "", file);
        assert.deepEqual(JSON.parse(result.stdout).summary, { failedTests: missed + unattributed, missed: 0, preExisting: 0, possibleMisses: missed, selected: 0, unattributed }, file);
      }
    });
  });

  it("does not call an unknown failure selected merely because the plan ran FULL", () => {
    fixture((directory, planPath, resultsPath) => {
      writeFileSync(planPath, JSON.stringify(selection("FULL")));
      writeFileSync(resultsPath, junit(failure("tests/selected.test.ts"), failure("tests/unknown.test.ts")));
      const result = run(directory, ["--plan", planPath, "--results", resultsPath]);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.mode, "FULL");
      assert.equal(report.fullFallback, true);
      assert.deepEqual(report.summary, { failedTests: 2, missed: 0, preExisting: 0, possibleMisses: 0, selected: 1, unattributed: 1 });
      assert.deepEqual(report.possibleMisses, []);
    });
  });

  it("fails for a missed failure alone and succeeds for a known FULL failure", () => {
    fixture((directory, planPath, resultsPath) => {
      for (const [mode, file, expected] of [
        ["SELECTIVE", "tests/skipped.test.ts", 1],
        ["FULL", "tests/selected.test.ts", 0],
      ] as const) {
        writeFileSync(planPath, JSON.stringify(selection(mode)));
        writeFileSync(resultsPath, junit(failure(file)));
        const result = run(directory, ["--plan", planPath, "--results", resultsPath]);
        assert.ifError(result.error);
        assert.equal(result.status, expected, result.stdout + result.stderr);
        assert.equal(result.stderr, "");
        const report = JSON.parse(result.stdout);
        assert.equal(report.summary.unattributed, 0);
        assert.equal(report.summary.possibleMisses, expected);
      }
    });
  });

  it("supports help, equals arguments, root mapping and base results through the public CLI", () => {
    fixture((directory, planPath, resultsPath) => {
      const help = run(directory, ["--help"]);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /--base-results/);
      const basePath = join(directory, "base.xml");
      const nestedPlan = { ...selection(), skippedTests: ["packages/web/tests/skipped.test.ts"] };
      writeFileSync(planPath, JSON.stringify(nestedPlan));
      writeFileSync(resultsPath, junit(failure("tests/skipped.test.ts")));
      writeFileSync(basePath, junit(failure("tests/skipped.test.ts")));
      const args = [`--plan=${planPath}`, `--results=${resultsPath}`, "--root=packages/web", `--repo=${directory}`, `--base-results=${basePath}`];
      const old = run(directory, args);
      assert.equal(old.status, 0, old.stderr);
      assert.equal(JSON.parse(old.stdout).summary.preExisting, 1);
      writeFileSync(basePath, junit('<testcase name="fails" file="tests/skipped.test.ts"/>'));
      const introduced = run(directory, args);
      assert.equal(introduced.status, 1, introduced.stderr);
      assert.equal(JSON.parse(introduced.stdout).missed[0].file, nestedPlan.skippedTests[0]);
      writeFileSync(basePath, "<testsuite>");
      invalid(directory, args);
      for (const root of ["../web", "/web", "packages/../web"]) {
        invalid(directory, ["--plan", planPath, "--results", resultsPath, "--root", root]);
      }
    });
  });

  it("rejects input growth after fstat instead of parsing a truncated prefix", () => {
    fixture((directory, planPath, resultsPath) => {
      const guard = join(directory, "growth.cjs");
      writeFileSync(guard, `
const fs = require('node:fs');
const stat = fs.fstatSync;
fs.fstatSync = (...args) => { const info = stat(...args); info.size -= 1; return info; };
require('node:module').syncBuiltinESMExports();
`);
      const result = run(directory, ["--plan", planPath, "--results", resultsPath], guard);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(JSON.parse(result.stderr).error, /grew while being read/);
    });
  });

  it("uses a separate base checkout and treats missing or skipped base evidence as uncertain", () => {
    fixture((directory, planPath, resultsPath) => {
      const basePath = join(directory, "base.xml");
      const baseRepo = join(directory, "base");
      writeFileSync(resultsPath, junit(failure(`${directory.replace(/\\/g, "/")}/tests/skipped.test.ts`)));
      writeFileSync(basePath, junit(failure(`${baseRepo.replace(/\\/g, "/")}/tests/skipped.test.ts`)));
      const args = ["--plan", planPath, "--results", resultsPath, "--base-results", basePath, "--repo", directory];
      let result = run(directory, args);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).summary.possibleMisses, 1);
      result = run(directory, [...args, "--base-repo", baseRepo]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).summary.preExisting, 1);
      writeFileSync(basePath, junit('<testcase file="tests/skipped.test.ts" name="fails"><skipped/></testcase>'));
      result = run(directory, args);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).summary.possibleMisses, 1);
      invalid(directory, ["--plan", planPath, "--results", resultsPath, "--base-repo", baseRepo]);
    });
  });

  it("enforce-misses rejects invalid full reports with exit 2 and no output artifact", () => {
    fixture((directory, _planPath, resultsPath) => {
      const output = join(directory, "reports");
      const repo = join(directory, "checkout");
      for (const input of ["<testsuite>", '<testsuite tests="2"><testcase name="only one"/></testsuite>', '<testsuite><system-out>' + 'x'.repeat(16 * 1024 * 1024) + '</system-out></testsuite>']) {
        writeFileSync(resultsPath, input);
        const result = spawnSync(process.execPath, [CLI, "enforce-misses", "--repo", repo, "--repository", "fixture/repo", "--junit", resultsPath, "--out-dir", output], { cwd: directory, encoding: "utf8" });
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /Cannot read full-suite JUnit:/);
        assert.doesNotMatch(result.stderr, /at SaxesParser|at runEnforceMisses/);
        assert.equal(result.stdout, "");
        assert.ok(!readdirSync(directory).includes("reports"));
      }
    });
  });

  it("enforce-misses retains primary failures when an explicit rerun report is truncated", () => {
    fixture((directory, _planPath, resultsPath) => {
      const output = join(directory, "reports");
      const rerun = join(directory, "rerun.xml");
      const guard = join(directory, "local-gh.cjs");
      writeFileSync(rerun, "<testsuite>");
      // Only remote history is replaced. The actual CLI, reader and report writer execute.
      writeFileSync(guard, `
const child = require('node:child_process');
child.spawnSync = (command, args) => {
  if (command !== 'gh' || args[0] !== 'api' || !args[1].includes('/actions/workflows/')) throw new Error('Unexpected child: ' + command);
  return {status: 0, stdout: JSON.stringify({workflow_runs: []}), stderr: ''};
};
require('node:module').syncBuiltinESMExports();
`);
      const result = spawnSync(process.execPath, ["--require", guard, CLI, "enforce-misses", "--repo", join(directory, "checkout"), "--head", "head", "--repository", "fixture/repo", "--junit", resultsPath, "--rerun-junit", rerun, "--out-dir", output], { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(readFileSync(join(output, "enforce-misses.json"), "utf8"));
      assert.equal(report.full_suite, "failed");
      assert.equal(report.rerun, "not-run");
      assert.equal(report.failures.length, 1);
      assert.equal(report.failures[0].classification, "unattributed");
      assert.match(report.notes.join("\n"), /rerun results unavailable/);
      assert.equal(report.deterministic_failures.length, 1);
    });
  });

  it("rejects missing, repeated, unknown and positional arguments before reading inputs", () => {
    fixture((directory, planPath, resultsPath) => {
      const valid = ["--plan", planPath, "--results", resultsPath];
      for (const args of [
        [], ["--plan"], ["--results"], ["--plan", "--results", resultsPath],
        ["--plan", planPath], ["--results", resultsPath],
        [...valid, "--plan", planPath], [...valid, "--results", resultsPath],
        [...valid, "--json"], [...valid, "--open-issue"], [...valid, "extra"],
      ]) invalid(directory, args);
    });
  });

  it("rejects unreadable, non-file, malformed and unsupported inputs with a JSON error", () => {
    fixture((directory, planPath, resultsPath) => {
      invalid(directory, ["--plan", join(directory, "missing.json"), "--results", resultsPath]);
      invalid(directory, ["--plan", planPath, "--results", join(directory, "missing.xml")]);
      invalid(directory, ["--plan", directory, "--results", resultsPath]);
      for (const plan of ["{", "null", JSON.stringify({ ...selection(), version: "999.0.0" }), JSON.stringify({ status: "OBSERVED", result: selection() })]) {
        writeFileSync(planPath, plan);
        invalid(directory, ["--plan", planPath, "--results", resultsPath]);
      }
      writeFileSync(planPath, JSON.stringify(selection()));
      for (const xml of ["<testsuite>", "<html/>", '<!DOCTYPE testsuite [<!ENTITY x "expanded">]><testsuite/>' ]) {
        writeFileSync(resultsPath, xml);
        invalid(directory, ["--plan", planPath, "--results", resultsPath]);
      }
    });
  });

  it("bounds both inputs and rejects malformed UTF-8 instead of replacing its bytes", () => {
    fixture((directory, planPath, resultsPath) => {
      for (const target of [planPath, resultsPath]) {
        const original = readFileSync(target);
        truncateSync(target, 16 * 1024 * 1024 + 1);
        invalid(directory, ["--plan", planPath, "--results", resultsPath]);
        writeFileSync(target, Buffer.from([0xc3, 0x28]));
        invalid(directory, ["--plan", planPath, "--results", resultsPath]);
        writeFileSync(target, original);
      }
      const json = JSON.stringify(selection());
      writeFileSync(planPath, json + " ".repeat(16 * 1024 * 1024 - Buffer.byteLength(json)));
      const atLimit = run(directory, ["--plan", planPath, "--results", resultsPath]);
      assert.ifError(atLimit.error);
      assert.equal(atLimit.status, 0, atLimit.stdout + atLimit.stderr);
      assert.equal(atLimit.stderr, "");
    });
  });

  it("runs without processes, network calls, telemetry or filesystem writes", () => {
    fixture((directory, planPath, resultsPath) => {
      // The subprocess still loads and executes the real CLI. Tripwires make forbidden work visible
      // even if another command's best-effort telemetry catches its error.
      const guard = join(directory, "guard.cjs");
      writeFileSync(guard, `
const unexpected = [];
const forbid = (name) => () => { unexpected.push(name); throw new Error('Unexpected side effect: ' + name); };
const fs = require('node:fs');
for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'truncate', 'truncateSync', 'createWriteStream']) {
  fs[name] = forbid('fs.' + name);
  if (fs.promises[name]) fs.promises[name] = forbid('fs.promises.' + name);
}
const originalOpen = fs.openSync;
fs.openSync = (path, flags, ...rest) => {
  const writing = typeof flags === 'string' ? /[wa+]/.test(flags) : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND);
  if (writing) return forbid('fs.openSync(write)')();
  return originalOpen(path, flags, ...rest);
};
const child = require('node:child_process');
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) child[name] = forbid('child_process.' + name);
for (const module of ['node:http', 'node:https']) {
  const network = require(module);
  network.request = forbid(module + '.request');
  network.get = forbid(module + '.get');
}
require('node:net').Socket.prototype.connect = forbid('net.connect');
globalThis.fetch = forbid('fetch');
require('node:module').syncBuiltinESMExports();
process.env.DIFFCI_API_URL = 'https://example.invalid';
process.env.DIFFCI_TOKEN = 'fixture-token';
process.env.DIFFCI_SHARE_USAGE = '1';
delete process.env.DIFFCI_NO_SEND;
process.on('exit', () => {
  if (unexpected.length) { process.stderr.write(JSON.stringify(unexpected)); process.exitCode = 91; }
});
`);
      for (const [xml, expected] of [
        [junit(failure("tests/selected.test.ts")), 0],
        [junit(failure("tests/skipped.test.ts")), 1],
        ["<testsuite>", 2],
      ] as const) {
        writeFileSync(resultsPath, xml);
        const before = readdirSync(directory).sort().map((path) => [path, readFileSync(join(directory, path), "utf8")]);
        const result = run(directory, ["--plan", planPath, "--results", resultsPath], guard);
        assert.ifError(result.error);
        assert.equal(result.status, expected, result.stdout + result.stderr);
        if (expected === 2) {
          assert.equal(result.stdout, "");
          assert.equal(JSON.parse(result.stderr).schemaVersion, 1);
        } else {
          assert.equal(result.stderr, "");
          assert.deepEqual(JSON.parse(result.stdout).summary, { failedTests: 1, missed: 0, preExisting: 0, possibleMisses: expected, selected: 1 - expected, unattributed: 0 });
        }
        assert.deepEqual(readdirSync(directory).sort().map((path) => [path, readFileSync(join(directory, path), "utf8")]), before);
      }
    });
  });
});
