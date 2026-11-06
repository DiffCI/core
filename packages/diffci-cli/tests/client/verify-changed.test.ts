import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-verify-changed-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@diffci.local");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  write(dir, "package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }));
  write(dir, "src/alpha.js", "export const alpha = () => 1;\n");
  write(dir, "src/beta.js", "export const beta = () => 2;\n");
  write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 1));\n");
  write(dir, "test/beta.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {beta} from '../src/beta.js'; test('beta', () => assert.equal(beta(), 2));\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

function localTestEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && !name.startsWith("GITHUB_")),
  );
}

function runVerify(dir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, "verify", "--changed", "--repo", dir, "--json"],
    { cwd: ROOT, encoding: "utf8", timeout: 600_000, env: localTestEnv() },
  );
}

function runVerifyRange(dir: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, "verify", "--repo", dir, "--json", ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 600_000, env: localTestEnv() },
  );
}

function commitAlphaChange(dir: string): { base: string; head: string } {
  const base = git(dir, "rev-parse", "HEAD");
  write(dir, "src/alpha.js", "export const alpha = () => 3;\n");
  write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 3));\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "change alpha");
  return { base, head: git(dir, "rev-parse", "HEAD") };
}

describe("verify --changed", () => {
  it("passes without executing a command when the working tree has no changes", () => {
    const dir = fixture();
    try {
      const run = runVerify(dir);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.verification, "passed");
      assert.equal(report.safe_to_continue, true);
      assert.equal(report.selection, "none");
      assert.equal(report.changed_files, 0);
      assert.equal(report.command, undefined);
      assert.equal(report.snapshot.unchanged, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies the current uncommitted snapshot with a selected command", () => {
    const dir = fixture();
    try {
      write(dir, "src/alpha.js", "export const alpha = () => 3;\n");
      write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 3));\n");
      const beforeStatus = git(dir, "status", "--porcelain=v1");

      const run = runVerify(dir);

      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.schema, "diffci.verification.v1");
      assert.equal(report.scope, "working-tree");
      assert.equal(report.commit_range, undefined);
      assert.equal(report.verification, "passed");
      assert.equal(report.safe_to_continue, true);
      assert.equal(report.selection, "selected");
      assert.equal(report.reason, "dependency impact");
      assert.equal(report.changed_files, 2);
      assert.equal(report.tests_available, 2);
      assert.equal(report.tests_selected, 1);
      assert.equal(report.snapshot.unchanged, true);
      assert.match(report.snapshot.before_tree_sha, /^[a-f0-9]{40}$/);
      assert.equal(report.snapshot.before_tree_sha, report.snapshot.after_tree_sha);
      assert.match(report.command, /node --test/);
      // Every selected test says which changed file selected it, and how.
      assert.deepEqual(Object.keys(report.selection_reasons), report.selected_tests);
      assert.deepEqual(report.selection_reasons["test/alpha.test.js"], { reason: "DEPENDENCY", changed_file: "src/alpha.js" });
      // The run is in the outcome log inside .git, which leaves the working tree untouched.
      assert.equal(git(dir, "status", "--porcelain=v1"), beforeStatus);
      const outcomes = spawnSync(process.execPath, ["--import", "tsx", CLI, "outcomes", "--repo", dir, "--json"], { cwd: ROOT, encoding: "utf8", env: localTestEnv() });
      const summary = JSON.parse(outcomes.stdout);
      assert.equal(summary.runs, 1);
      assert.equal(summary.selected, 1);
      assert.equal(summary.passed, 1);
      // Each test file's result and duration, from the node:test probe (2026-11-06).
      const record = JSON.parse(readFileSync(join(dir, ".git", "diffci", "outcomes.jsonl"), "utf8").trim());
      assert.deepEqual(record.test_results.map(({ file, status }: { file: string; status: string }) => ({ file, status })), [{ file: "test/alpha.test.js", status: "passed" }]);
      assert.equal(typeof record.test_results[0].ms, "number");
      assert.equal(record.node_version, process.versions.node);
      assert.match(record.command, /node --test/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an earlier pass of the same tree and runs nothing, unless --no-reuse", () => {
    const dir = fixture();
    try {
      write(dir, "src/alpha.js", "export const alpha = () => 3;\n");
      write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 3));\n");
      const first = JSON.parse(runVerify(dir).stdout);
      assert.equal(first.verification, "passed");
      assert.equal(first.reused_from, undefined);

      const second = runVerify(dir);
      assert.equal(second.status, 0, second.stdout + second.stderr);
      const reused = JSON.parse(second.stdout);
      assert.equal(reused.verification, "passed");
      assert.equal(reused.reused_from.produced_at, first.produced_at);
      assert.equal(reused.execution, undefined, "nothing ran");
      assert.match(reused.reason, /reused the passing selected run/);

      const again = spawnSync(process.execPath, ["--import", "tsx", CLI, "verify", "--changed", "--repo", dir, "--json", "--no-reuse"], { cwd: ROOT, encoding: "utf8", timeout: 600_000, env: localTestEnv() });
      const rerun = JSON.parse(again.stdout);
      assert.equal(rerun.reused_from, undefined);
      assert.equal(rerun.execution.exitCode, 0);

      // A different tree is never covered.
      write(dir, "src/beta.js", "export const beta = () => 2; // touched\n");
      assert.equal(JSON.parse(runVerify(dir).stdout).reused_from, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a test that failed before first, and --fail-fast stops after it", () => {
    const dir = fixture();
    try {
      write(dir, "src/alpha.js", "export const alpha = () => 1; // touched\n");
      write(dir, "src/beta.js", "export const beta = () => 5;\n");
      const first = JSON.parse(runVerify(dir).stdout);
      assert.equal(first.verification, "failed");
      assert.match(first.command, /alpha\.test\.js.*beta\.test\.js/, "no history yet: the selection's own order");

      const fast = spawnSync(process.execPath, ["--import", "tsx", CLI, "verify", "--changed", "--repo", dir, "--json", "--fail-fast"], { cwd: ROOT, encoding: "utf8", timeout: 600_000, env: localTestEnv() });
      const stopped = JSON.parse(fast.stdout);
      assert.equal(stopped.verification, "failed");
      assert.equal(stopped.commands.length, 2);
      assert.match(stopped.commands[0], /beta\.test\.js$/);
      assert.equal(stopped.execution.partsNotRun, 1);
      assert.match(stopped.reason, /--fail-fast stopped at the first failing part/);

      write(dir, "src/beta.js", "export const beta = () => 2; // fixed\n");
      const fixed = JSON.parse(runVerify(dir).stdout);
      assert.equal(fixed.verification, "passed");
      assert.match(fixed.command, /beta\.test\.js.*alpha\.test\.js/, "beta failed before, so it runs first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when selected verification fails", () => {
    const dir = fixture();
    try {
      write(dir, "src/alpha.js", "export const alpha = () => 99;\n");
      const run = runVerify(dir);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.verification, "failed");
      assert.equal(report.safe_to_continue, false);
      assert.equal(report.selection, "selected");
      assert.equal(report.execution.exitCode, 1);
      assert.equal(report.snapshot.unchanged, true);
      assert.equal(report.required_actions.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verify commit range", () => {
  it("verifies an explicit range and binds the receipt to checked-out HEAD", () => {
    const dir = fixture();
    try {
      const { base, head } = commitAlphaChange(dir);
      const run = runVerifyRange(dir, ["--base", base, "--head", head]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.scope, "commit-range");
      assert.equal(report.verification, "passed");
      assert.equal(report.safe_to_continue, true);
      assert.equal(report.selection, "selected");
      assert.equal(report.commit_range.base_sha, base);
      assert.equal(report.commit_range.head_sha, head);
      assert.equal(report.snapshot.base_sha, head);
      assert.equal(report.snapshot.after_base_sha, head);
      assert.equal(report.snapshot.unchanged, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves HEAD parent automatically outside CI", () => {
    const dir = fixture();
    try {
      const { base, head } = commitAlphaChange(dir);
      const run = runVerifyRange(dir);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.commit_range.base_sha, base);
      assert.equal(report.commit_range.head_sha, head);
      assert.equal(report.commit_range.source, "head-parent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a dirty checkout before commit-range analysis", () => {
    const dir = fixture();
    try {
      commitAlphaChange(dir);
      write(dir, "src/beta.js", "export const beta = () => 4;\n");
      const run = runVerifyRange(dir);
      assert.equal(run.status, 2, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.verification, "blocked");
      assert.equal(report.safe_to_continue, false);
      assert.equal(report.analysis.status, "not_needed");
      assert.match(report.reason, /requires a clean checkout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when the analyzed head is not the commit being executed", () => {
    const dir = fixture();
    try {
      const { base, head } = commitAlphaChange(dir);
      write(dir, "README.md", "later checkout\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "later checkout");
      const checkedOutHead = git(dir, "rev-parse", "HEAD");

      const run = runVerifyRange(dir, ["--base", base, "--head", head]);
      assert.equal(run.status, 2, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.verification, "blocked");
      assert.equal(report.commit_range.head_sha, head);
      assert.equal(report.snapshot.base_sha, checkedOutHead);
      assert.match(report.reason, /is not the checked-out HEAD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

