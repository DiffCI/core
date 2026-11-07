import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "dist-client", "src", "client", "cli.js");
const CORE_CLI = join(ROOT, "node_modules", "@diffci.com", "core", "dist", "cli.js");

let temp = "";
let repo = "";
let base = "";
let head = "";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function run(script: string, args: string[], cwd = temp) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", timeout: 60_000, env });
}

before(() => {
  const build = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.client.json"], { cwd: ROOT, encoding: "utf8" });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stdout + build.stderr);

  temp = mkdtempSync(join(tmpdir(), "diffci-plan-"));
  repo = join(temp, "repo");
  mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "test@diffci.local"]);
  git(repo, ["config", "user.name", "DiffCI plan test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  write(join(repo, "package.json"), `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  write(join(repo, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }, null, 2)}\n`);
  write(join(repo, "src", "alpha.js"), "export const alpha = () => 1;\n");
  write(join(repo, "src", "beta.js"), "export const beta = () => 2;\n");
  write(join(repo, "test", "alpha.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { alpha } from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 1));\n");
  write(join(repo, "test", "beta.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { beta } from '../src/beta.js'; test('beta', () => assert.equal(beta(), 2));\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "initial"]);
  base = git(repo, ["rev-parse", "HEAD"]);
  write(join(repo, "src", "alpha.js"), "export const alpha = () => 42;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "change alpha"]);
  head = git(repo, ["rev-parse", "HEAD"]);
});

after(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

describe("plan CLI", () => {
  it("prints the same advisory plan as Core's plan command", () => {
    const result = run(CLI, ["plan", "--repo", repo, `--base=${base}`, "--head", head]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.advisoryOnly, true);
    assert.equal(output.base, base);
    assert.equal(output.head, head);
    assert.equal(output.plan.version, "5.0.0");
    assert.ok(output.plan.selectedTests.includes("test/alpha.test.js"));
    assert.ok(output.plan.skippedTests.includes("test/beta.test.js"));

    const core = run(CORE_CLI, ["plan", "--repo", repo, "--base", base, "--head", head]);
    assert.equal(core.status, 0, core.stdout + core.stderr);
    const expected = JSON.parse(core.stdout);
    // Analysis timing is the only field allowed to differ between two runs.
    delete output.impact.performance;
    delete expected.impact.performance;
    assert.deepEqual(output, expected);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  });

  it("defaults --repo to the working directory and --head to HEAD", () => {
    const result = run(CLI, ["plan", "--base", base], repo);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).head, head);
  });

  it("produces a plan check-plan accepts", () => {
    const planPath = join(temp, "plan.json");
    const resultsPath = join(temp, "junit.xml");
    writeFileSync(planPath, run(CLI, ["plan", "--repo", repo, "--base", base, "--head", head]).stdout);
    writeFileSync(resultsPath, '<testsuites><testsuite name="s"><testcase name="alpha" file="test/alpha.test.js"><failure/></testcase></testsuite></testsuites>');
    const result = run(CLI, ["check-plan", "--plan", planPath, "--results", resultsPath, "--repo", repo]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).summary.selected, 1);
  });

  it("prints usage for --help", () => {
    const result = run(CLI, ["plan", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: diffci plan --base <commit>/);
  });

  for (const [name, args] of [
    ["a missing --base", ["plan", "--repo", "REPO"]],
    ["an unknown flag", ["plan", "--base", "BASE", "--out", "plan.json"]],
    ["a repeated flag", ["plan", "--base", "BASE", "--base", "BASE"]],
    ["a flag without a value", ["plan", "--base"]],
    ["a head that is not checked out", ["plan", "--repo", "REPO", "--base", "BASE", "--head", "BASE"]],
  ] as const) {
    it(`fails closed on ${name}`, () => {
      const resolved = args.map((arg) => arg === "REPO" ? repo : arg === "BASE" ? base : arg);
      const result = run(CLI, resolved, repo);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, "");
      const error = JSON.parse(result.stderr);
      assert.equal(error.recommendation, "RUN_FULL_CI");
      assert.ok(error.error.length > 0);
    });
  }

  it("refuses a dirty checkout", () => {
    write(join(repo, "untracked.txt"), "dirty\n");
    try {
      const result = run(CLI, ["plan", "--repo", repo, "--base", base]);
      assert.equal(result.status, 1);
      assert.match(JSON.parse(result.stderr).error, /clean/);
    } finally {
      rmSync(join(repo, "untracked.txt"));
    }
  });
});
