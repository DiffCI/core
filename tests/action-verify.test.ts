// SPDX-License-Identifier: MIT
// The Action's opt-in fast check (action/verify.sh), run against a stub `npx` that records its
// arguments and exits with a chosen code, so no CLI is installed and no repository code runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("../action/verify.sh", import.meta.url));

function runVerify(env: Record<string, string>, stubExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "diffci-action-verify-"));
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  mkdirSync(bin);
  mkdirSync(temp);
  const argsFile = join(root, "npx-args.txt");
  writeFileSync(
    join(bin, "npx"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${argsFile.replace(/\\/g, "/")}"`,
      "echo 'DiffCI verification: stub'",
      `printf '%s\\n' "\${STUB_TEXT:-}"`,
      `exit ${stubExit}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const output = join(root, "output.txt");
  const summary = join(root, "summary.md");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const run = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      DIFFCI_REPO: root,
      DIFFCI_CLI_VERSION: "0.3.37",
      DIFFCI_FULL: "false",
      DIFFCI_REASON: "",
      DIFFCI_VERIFY_CHECKS: "true",
      DIFFCI_VERIFY_TIMEOUT: "20",
      DIFFCI_BASE: "",
      DIFFCI_HEAD: "",
      ...env,
    },
  });
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
  const args = read(argsFile).split(/\r?\n/).filter(Boolean);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, outputs: read(output), summary: read(summary), args };
}

test("a change DiffCI could not narrow runs nothing and passes", () => {
  const run = runVerify({ DIFFCI_FULL: "true", DIFFCI_REASON: "lockfile changed" });
  assert.equal(run.status, 0);
  assert.deepEqual(run.args, [], "the CLI is not started");
  assert.match(run.outputs, /^status=skipped$/m);
  assert.match(run.summary, /fast check: skipped[\s\S]*lockfile changed/);
});

test("a missing impact answer is treated as needing the full suite", () => {
  const run = runVerify({ DIFFCI_FULL: "" });
  assert.equal(run.status, 0);
  assert.deepEqual(run.args, []);
  assert.match(run.outputs, /^status=skipped$/m);
});

test("a narrowed change runs verify fail-fast with checks, sending and logging nothing", () => {
  const run = runVerify({});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.args[0], "--yes");
  assert.ok(run.args.includes("@diffci.com/diffci@0.3.37"));
  const verify = run.args.slice(run.args.indexOf("diffci") + 1);
  assert.equal(verify[0], "verify");
  for (const flag of ["--fail-fast", "--checks", "--no-send", "--no-log"]) assert.ok(verify.includes(flag), `${flag} is passed`);
  assert.equal(verify[verify.indexOf("--timeout-ms") + 1], String(20 * 60000));
  assert.ok(!verify.includes("--base") && !verify.includes("--head"), "the CI event range is used by default");
  assert.match(run.outputs, /^status=passed$/m);
  assert.match(run.summary, /fast check: passed/);
  assert.match(run.summary, /DiffCI verification: stub/, "the CLI output is in the summary");
});

test("verify-checks false and an explicit range reach the CLI", () => {
  const run = runVerify({ DIFFCI_VERIFY_CHECKS: "false", DIFFCI_BASE: "abc123", DIFFCI_HEAD: "def456" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.args.includes("--no-checks"));
  assert.ok(!run.args.includes("--checks"));
  assert.equal(run.args[run.args.indexOf("--base") + 1], "abc123");
  assert.equal(run.args[run.args.indexOf("--head") + 1], "def456");
});

test("failing tests or checks fail the step", () => {
  const run = runVerify({}, 1);
  assert.equal(run.status, 1);
  assert.match(run.outputs, /^status=failed$/m);
  assert.match(run.stdout, /::error title=DiffCI fast check::/);
  assert.match(run.summary, /fast check: failed/);
});

test("a DiffCI problem only warns", () => {
  for (const code of [2, 127]) {
    const run = runVerify({}, code);
    assert.equal(run.status, 0, `exit ${code} does not fail the step`);
    assert.match(run.outputs, /^status=blocked$/m);
    assert.match(run.stdout, /::warning title=DiffCI fast check::/);
  }
});

test("invalid inputs are refused before anything runs", () => {
  for (const env of <Array<Record<string, string>>>[{ DIFFCI_VERIFY_TIMEOUT: "0" }, { DIFFCI_VERIFY_TIMEOUT: "20; rm -rf /" }, { DIFFCI_VERIFY_CHECKS: "yes" }, { DIFFCI_CLI_VERSION: "latest" }]) {
    const run = runVerify(env);
    assert.equal(run.status, 2, JSON.stringify(env));
    assert.deepEqual(run.args, [], "the CLI is not started");
  }
});

test("repository output cannot close the summary fence", () => {
  const run = runVerify({ STUB_TEXT: "~~~~~~~~\n### injected heading" }, 1);
  assert.equal(run.summary.split("\n").filter((line) => line === "~~~~~~~~").length, 1, "only the closing fence line");
  assert.ok(!run.summary.split("\n").includes("### injected heading") || run.summary.indexOf("### injected heading") < run.summary.lastIndexOf("~~~~~~~~"), "the output stays inside the fence");
});
