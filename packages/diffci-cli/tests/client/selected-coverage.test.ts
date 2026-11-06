import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { batchCommand } from "../../src/client/command-batches.js";
import { commandArguments, runnerTestCount, selectedNodeTests, traceNodeTestFiles, unmatchedNodeTests, unstartedNodeTests } from "../../src/client/selected-coverage.js";
import { measureCommand } from "../../src/client/verify-savings.js";
import { executableSelection } from "../../src/client/verify.js";
import type { ObservationReport } from "../../src/client/report.js";

// DentalPresence ebac4289f73a, CLI 0.3.21: the selected route test was handed to node --test as a glob
// that matches nothing, the other selected files passed, and verify reported passed.
const nextPaths = ["src/app/[id]/page.test.ts", "src/app/ingest/[...path]/route.test.ts", "src/app/docs/[[...slug]]/route.test.ts"];
// CLI 0.3.22 (Core 68c3f0a): one-character classes, which npx's second shell expanded back on Linux.
const escaped = ['"src/app/[[]id[]]/page.test.ts"', '"src/app/ingest/[[]...path[]]/route.test.ts"', '"src/app/docs/[[][[]...slug[]][]]/route.test.ts"'];
// Since 2026-11-02: each class wrapped in an extglob, so npx quotes it.
const wrapped = ['"src/app/@([[])id@([]])/page.test.ts"', '"src/app/ingest/@([[])...path@([]])/route.test.ts"', '"src/app/docs/@([[])@([[])...slug@([]])@([]])/route.test.ts"'];

type Result = NonNullable<ObservationReport["result"]>;
const result = (fields: Partial<Result>) => ({
  mode: "SELECTIVE", selectedTests: ["src/a.test.js"], totalTestCount: 10, fallbackReasons: [],
  proposedCommands: ["node --test src/a.test.js"], ...fields,
}) as Result;

test("reads the arguments sh or cmd.exe would pass, for the quoting DiffCI emits", () => {
  assert.deepEqual(commandArguments('node --test "src/app/[[]id[]]/x.test.ts" a\\ b.ts', false), ["node", "--test", "src/app/[[]id[]]/x.test.ts", "a b.ts"]);
  assert.deepEqual(commandArguments("node --test src/app/\\[id\\]/x.test.ts", false), ["node", "--test", "src/app/[id]/x.test.ts"]);
  assert.deepEqual(commandArguments("node --test src/app/\\[id\\]/x.test.ts", true), ["node", "--test", "src/app/\\[id\\]/x.test.ts"]);
});

test("finds the selected files node --test would not match, as 0.3.21 emitted them", () => {
  const legacy = "npx --no-install tsx --conditions react-server --test src/a.test.ts src/app/ingest/\\[...path\\]/route.test.ts";
  assert.deepEqual(unmatchedNodeTests(legacy, ["src/a.test.ts", "src/app/ingest/[...path]/route.test.ts"]), ["src/app/ingest/[...path]/route.test.ts"]);
  assert.deepEqual(unmatchedNodeTests(`node --test src/a.test.ts ${escaped.join(" ")}`, ["src/a.test.ts", ...nextPaths]), []);
  assert.deepEqual(unmatchedNodeTests("pnpm exec vitest run src/app/[id]/page.test.ts", ["src/app/[id]/page.test.ts"]), []);
});

test("broadens to the full suite instead of running a selection that skips a selected file", () => {
  const plan = executableSelection("/repo", result({
    selectedTests: ["src/a.test.js", "src/app/ingest/[...path]/route.test.js"],
    proposedCommands: ["node --test src/a.test.js src/app/ingest/\\[...path\\]/route.test.js"],
  }));
  assert.equal(plan.selection, "full");
  assert.match(plan.reason, /node --test would not match 1 selected test file\(s\), such as src\/app\/ingest\/\[\.\.\.path\]\/route\.test\.js/);

  const selected = executableSelection("/repo", result({
    selectedTests: ["src/a.test.js", "src/app/ingest/[...path]/route.test.js"],
    proposedCommands: ['node --test src/a.test.js "src/app/ingest/[[]...path[]]/route.test.js"'],
  }));
  assert.equal(selected.selection, "selected");
});

test("models the second sh -c that npx runs a bin through (DentalPresence ebac4289f73a, CLI 0.3.22)", () => {
  const npx = (args: readonly string[]) => `npx --no-install tsx --conditions react-server --test src/a.test.ts ${args.join(" ")}`;
  // Linux: the unquoted class reaches npx's shell, which expands it back to the literal bracket path.
  assert.deepEqual(unmatchedNodeTests(npx(escaped), ["src/a.test.ts", ...nextPaths], false), nextPaths);
  // cmd.exe never expands, and node direct sees only one shell.
  assert.deepEqual(unmatchedNodeTests(npx(escaped), ["src/a.test.ts", ...nextPaths], true), []);
  assert.deepEqual(unmatchedNodeTests(`node --test src/a.test.ts ${escaped.join(" ")}`, ["src/a.test.ts", ...nextPaths], false), []);
  // The extglob's parentheses make npx quote it on every platform.
  for (const windows of [false, true]) {
    assert.deepEqual(unmatchedNodeTests(npx(wrapped), ["src/a.test.ts", ...nextPaths], windows), []);
    assert.deepEqual(selectedNodeTests(npx(wrapped), ["src/a.test.ts", ...nextPaths, "src/other.test.ts"], windows), ["src/a.test.ts", ...nextPaths]);
  }
});

test("splits an over-long selection with escaped bracket paths", () => {
  for (const form of [escaped, wrapped]) {
    const command = `node --test ${form.join(" ")}`;
    const batches = batchCommand(command, nextPaths, 80);
    assert.deepEqual(batches, form.map((arg) => `node --test ${arg}`));
  }
});

test("records which node --test files started, through the shell the CLI uses", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-node-test-trace-test-"));
  try {
    for (const path of ["src/a.test.js", "src/app/[id]/b.test.js"]) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), `require("node:test")(${JSON.stringify(path)}, () => {});\n`);
    }
    const selected = ["src/a.test.js", "src/app/[id]/b.test.js"];
    // As 0.3.21 emitted it: node reads the literal bracket path as a class and runs only a.test.js.
    const command = "node --test src/a.test.js src/app/[id]/b.test.js".replace(/\[id\]/, process.platform === "win32" ? "[id]" : "\\[id\\]");
    for (const [extra, started] of [["", ["src/a.test.js"]], [" --test-isolation=none", undefined]] as const) {
      const trace = traceNodeTestFiles(dir, "--no-warnings");
      try {
        const run = measureCommand(command.replace("--test", `--test${extra}`), { cwd: dir, timeoutMs: 60_000, tailBytes: 4096, env: trace.env });
        assert.equal(run.exitCode, 0, run.stderrTail);
        assert.equal(run.runnerTestCount, 1);
        assert.deepEqual(trace.read(), started);
        // A partial trace names the file that never started; an empty one proves nothing.
        assert.deepEqual(unstartedNodeTests(selectedNodeTests(command, selected), trace.read()), started ? ["src/app/[id]/b.test.js"] : []);
      } finally {
        trace.dispose();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records each node --test file's result and duration", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-node-test-results-test-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/pass.test.js"), `require("node:test")("pass", () => {});\n`);
    writeFileSync(join(dir, "src/fail.test.js"), `require("node:test")("fail", () => { throw new Error("no"); });\n`);
    const trace = traceNodeTestFiles(dir, "--no-warnings");
    try {
      const run = measureCommand("node --test src/pass.test.js src/fail.test.js", { cwd: dir, timeoutMs: 60_000, tailBytes: 4096, env: trace.env });
      assert.equal(run.exitCode, 1, run.stderrTail);
      const results = trace.results();
      assert.deepEqual(results.map(({ file, status }) => ({ file, status })), [
        { file: "src/fail.test.js", status: "failed" },
        { file: "src/pass.test.js", status: "passed" },
      ]);
      assert.ok(results.every((result) => typeof result.ms === "number" && result.ms >= 0));
    } finally {
      trace.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compares started files case-insensitively only on Windows", () => {
  assert.deepEqual(unstartedNodeTests(["src/A.test.ts"], ["src/a.test.ts"], true), []);
  assert.deepEqual(unstartedNodeTests(["src/A.test.ts"], ["src/a.test.ts"], false), ["src/A.test.ts"]);
  assert.deepEqual(unstartedNodeTests(["src/a.test.ts"], undefined, false), []);
});

// The DentalPresence shape end to end: a tsx test script, a co-located test under `[...path]`, and a
// seeded bug in the route committed with another change. Under CLI 0.3.22 on Linux this reported passed.
test("verify catches a seeded bug covered only by a test under a Next.js [...path] directory", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(join(tmpdir(), "diffci-bracket-verify-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path: string, contents: string) => {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  };
  try {
    git("init", "--quiet");
    git("config", "user.email", "test@diffci.local");
    git("config", "user.name", "Test");
    git("config", "core.autocrlf", "false");
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
    write(".gitignore", "node_modules\n");
    write("package.json", JSON.stringify({ name: "fixture", type: "module", private: true, scripts: { test: 'tsx --test "src/**/*.test.ts"' } }));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, noEmit: true }, include: ["src"] }));
    write("src/app/x/[...path]/route.ts", "export const accepts = (method: string): boolean => method === \"GET\";\n");
    write("src/app/x/[...path]/route.test.ts", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { accepts } from \"./route.ts\";\ntest(\"the catch-all route accepts GET\", () => assert.equal(accepts(\"GET\"), true));\n");
    write("src/lib/other.ts", "export const other = (): number => 1;\n");
    write("src/lib/other.test.ts", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { other } from \"./other.ts\";\ntest(\"other\", () => assert.equal(other(), 1));\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "initial");
    write("src/app/x/[...path]/route.ts", "export const accepts = (method: string): boolean => method !== \"GET\";\n");
    write("src/lib/other.ts", "export const other = (): number => 1; // touched\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");

    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && !name.startsWith("GITHUB_")));
    const run = spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "client", "cli.ts"), "verify", "--repo", dir, "--base", "HEAD~1", "--head", "HEAD", "--no-checks", "--json"], { cwd: root, encoding: "utf8", timeout: 600_000, env });
    const report = JSON.parse(run.stdout);
    assert.equal(report.verification, "failed", JSON.stringify({ reason: report.reason, command: report.command, stdout: report.execution?.stdoutTail }, null, 2));
    assert.ok(report.execution.failingTests.includes("the catch-all route accepts GET"), report.execution.failingTests);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the runner's own test count from its summary", () => {
  assert.equal(runnerTestCount("✔ a\nℹ tests 120\nℹ suites 3\nℹ pass 120\n"), 120);
  assert.equal(runnerTestCount("TAP version 13\n# tests 0\n# pass 0\n"), 0);
  assert.equal(runnerTestCount(" Test Files  3 passed (3)\n      Tests  17 passed (17)\n"), 3);
  assert.equal(runnerTestCount("Test Suites: 1 failed, 4 passed, 5 total\nTests:       9 passed, 9 total\n"), 5);
  assert.equal(runnerTestCount("ok\n"), undefined);
});
