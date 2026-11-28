import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { PlannedCheck } from "../../src/client/gate-checks.js";
import { GATE_PLAN_SCHEMA, type GatePlan } from "../../src/client/gate.js";
import { githubOutput, outputKey, planSteps, type StepPlan } from "../../src/client/plan-steps.js";

function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents, "utf8");
}

const CI = `name: ci
on: [pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - name: Lint
        run: npm run lint
  types:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          set -euo pipefail
          npm ci
          npm run typecheck
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run check
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run build
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: some-org/run-e2e@v1
  codeql:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
`;

const DEPLOY = `on: push
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
  deploy:
    needs: verify
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`;

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-plan-steps-"));
  write(dir, "package.json", JSON.stringify({ scripts: { check: "npm run lint && npm run typecheck", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc -p .", test: "node --test" } }));
  write(dir, ".github/workflows/ci.yml", CI);
  write(dir, ".github/workflows/deploy.yml", DEPLOY);
  return dir;
}

const check = (id: string, decision: PlannedCheck["decision"], command = `npm run ${id}`): PlannedCheck =>
  ({ id, kind: id === "typecheck" ? "typecheck" : "lint", decision, command, reason: `${id} ${decision.toLowerCase()} reason` });

function gatePlan(fields: Partial<GatePlan> = {}): GatePlan {
  return {
    schema: GATE_PLAN_SCHEMA, diffci_version: "test",
    range: { base_sha: "a".repeat(40), head_sha: "b".repeat(40), source: "explicit" },
    analysis: { status: "OBSERVED", mode: "SELECTIVE", fallback_reasons: [] },
    checks: [],
    tests: { selection: "selected", reason: "dependency impact", tests_selected: 0, tests_available: 10 },
    ...fields,
  };
}

function plan(dir: string, options: { checks: PlannedCheck[]; gate?: GatePlan; mode?: "observe" | "enforce"; workflow?: string }): StepPlan {
  return planSteps({
    repoPath: dir, plan: options.gate ?? gatePlan(), mode: options.mode ?? "observe", ...(options.workflow ? { workflow: options.workflow } : {}),
    checksFor: () => options.checks,
  });
}

const job = (result: StepPlan, id: string) => result.jobs.find((entry) => entry.job === id)!;

describe("planSteps", () => {
  it("skips jobs whose every check and test step DiffCI would skip, and runs the rest", () => {
    const dir = repo();
    try {
      const result = plan(dir, { checks: [check("lint", "SKIP"), check("typecheck", "SKIP")], workflow: "ci.yml" });
      assert.equal(job(result, "lint").decision, "skip");
      assert.equal(job(result, "types").decision, "skip", "set -euo pipefail and npm ci are setup");
      assert.equal(job(result, "test").decision, "skip");
      assert.match(job(result, "test").reason, /every check and test step is skipped/);
      assert.equal(job(result, "gate").decision, "skip", "npm run check runs the gate's leaves");
      assert.equal(job(result, "build").decision, "run");
      assert.match(job(result, "build").reason, /`npm run build`, which DiffCI does not plan/);
      assert.equal(job(result, "e2e").decision, "run");
      assert.match(job(result, "e2e").reason, /some-org\/run-e2e@v1, which DiffCI does not recognise/);
      assert.equal(job(result, "codeql").decision, "run", "security jobs always run");
      // Observe mode never turns a job off.
      assert.ok(result.jobs.every((entry) => entry.should_run));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("narrows a job when nothing in it runs in full, and gives the narrowed command", () => {
    const dir = repo();
    try {
      const gate = gatePlan({ tests: { selection: "selected", reason: "dependency impact", tests_selected: 2, tests_available: 10, selected_commands: ["node --test test/a.test.js test/b.test.js"] } });
      const result = plan(dir, { gate, checks: [check("lint", "NARROWED", "npx --no-install eslint src/a.ts"), check("typecheck", "RUN")], workflow: "ci.yml", mode: "enforce" });
      assert.equal(job(result, "lint").decision, "narrowed");
      assert.equal(job(result, "lint").steps.at(-1)!.narrowed_command, "npx --no-install eslint src/a.ts");
      assert.equal(job(result, "test").decision, "narrowed");
      assert.match(job(result, "test").reason, /2\/10 test files selected/);
      assert.equal(job(result, "types").decision, "run");
      assert.equal(job(result, "gate").decision, "run", "the gate runs typecheck in full");
      const output = githubOutput(result);
      assert.match(output, /^lint=narrowed$/m);
      assert.match(output, /^lint_should_run=true$/m);
      assert.match(output, /^lint_step_4<<DIFFCI_EOF_lint_4\nnpx --no-install eslint src\/a\.ts\nDIFFCI_EOF_lint_4$/m);
      assert.match(output, /^test_step_3<<DIFFCI_EOF_test_3\nnode --test test\/a\.test\.js test\/b\.test\.js\nDIFFCI_EOF_test_3$/m);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("turns skipped jobs off only in enforce mode, and leaves narrowed commands out in observe", () => {
    const dir = repo();
    try {
      const checks = [check("lint", "NARROWED", "npx --no-install eslint src/a.ts"), check("typecheck", "SKIP")];
      const enforce = plan(dir, { checks, workflow: "ci.yml", mode: "enforce" });
      assert.equal(job(enforce, "types").should_run, false);
      assert.equal(job(enforce, "build").should_run, true);
      assert.match(githubOutput(enforce), /^types_should_run=false$/m);
      const observe = githubOutput(plan(dir, { checks, workflow: "ci.yml" }));
      assert.match(observe, /^diffci_mode=observe$/m);
      assert.match(observe, /^types=skip$/m);
      assert.match(observe, /^types_should_run=true$/m);
      assert.doesNotMatch(observe, /_step_/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs a job that a running job needs, because GitHub would skip the dependent too", () => {
    const dir = repo();
    try {
      const result = plan(dir, { checks: [check("lint", "SKIP")], workflow: ".github/workflows/deploy.yml", mode: "enforce" });
      assert.equal(job(result, "deploy").decision, "run");
      assert.equal(job(result, "verify").decision, "run");
      assert.match(job(result, "verify").reason, /deploy needs it/);
      assert.equal(job(result, "verify").should_run, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs every job when the change could not be analysed", () => {
    const dir = repo();
    try {
      const gate = gatePlan({ analysis: { status: "ERROR", reason: "no merge base", fallback_reasons: [] } });
      const result = plan(dir, { gate, checks: [check("lint", "SKIP")], mode: "enforce" });
      assert.ok(result.jobs.length > 0);
      assert.ok(result.jobs.every((entry) => entry.decision === "run" && entry.should_run));
      assert.match(job(result, "lint").reason, /could not be analysed \(no merge base\)/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs a step whose script needs a shell DiffCI does not model", () => {
    const dir = repo();
    try {
      write(dir, ".github/workflows/ci.yml", `jobs:\n  lint:\n    steps:\n      - run: |\n          if [ -n "$CI" ]; then npm run lint; fi\n  matrix:\n    steps:\n      - run: npm run lint -- \${{ matrix.dir }}\n`);
      const result = plan(dir, { checks: [check("lint", "SKIP")], workflow: "ci.yml" });
      assert.equal(job(result, "lint").decision, "run");
      assert.equal(job(result, "matrix").decision, "run");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("names outputs GitHub can read", () => {
    assert.equal(outputKey("unit-tests (node 22)"), "unit_tests__node_22_");
  });
});

describe("diffci plan --steps", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "client", "cli.ts"), "plan", "--steps", ...args], {
    cwd: ROOT, encoding: "utf8",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && !name.startsWith("GITHUB_") && name !== "CI")), DO_NOT_TRACK: "1" },
  });

  it("writes job decisions and a narrowed test command to the output file, and never fails the build", { timeout: 300_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-plan-steps-cli-"));
    try {
      git(dir, "init", "--quiet");
      git(dir, "config", "user.email", "test@diffci.local");
      git(dir, "config", "user.name", "Test");
      git(dir, "config", "core.autocrlf", "false");
      write(dir, "package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { lint: "eslint src", test: "node --test" } }));
      write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { allowJs: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src", "test"] }));
      write(dir, "src/a.js", "export const a = () => 1;\n");
      write(dir, "src/b.js", "export const b = () => 2;\n");
      write(dir, "test/a.test.js", "import test from 'node:test'; import { a } from '../src/a.js'; test('a', () => a());\n");
      write(dir, "test/b.test.js", "import test from 'node:test'; import { b } from '../src/b.js'; test('b', () => b());\n");
      write(dir, ".github/workflows/ci.yml", "on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run build\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "initial");
      const base = git(dir, "rev-parse", "HEAD");
      write(dir, "src/a.js", "export const a = () => 3;\n");
      git(dir, "commit", "--quiet", "-am", "change a");
      const out = `${dir}.out`;
      const run = cli(["--repo", dir, "--base", base, "--format", "github-output", "--mode", "enforce", "--out", out]);
      assert.equal(run.status, 0, run.stderr);
      const output = readFileSync(out, "utf8");
      rmSync(out, { force: true });
      assert.match(output, /^diffci_analysis=OBSERVED$/m);
      assert.match(output, /^test=narrowed$/m);
      assert.match(output, /^test_step_3<<DIFFCI_EOF_test_3\nnode --test test\/a\.test\.js\nDIFFCI_EOF_test_3$/m);
      assert.match(output, /^build=run$/m);
      assert.match(run.stderr, /#build: run - step 1 runs `npm run build`, which DiffCI does not plan/);

      const refused = cli(["--repo", dir, "--base", "no-such-commit", "--format", "json"]);
      assert.equal(refused.status, 0, refused.stderr);
      const plan = JSON.parse(refused.stdout) as StepPlan;
      assert.notEqual(plan.analysis.status, "OBSERVED");
      assert.ok(plan.jobs.every((entry) => entry.decision === "run" && entry.should_run));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("examples/github-actions-step-plan.yml", () => {
  it("lets DiffCI skip its own wired jobs: the narrowed-command steps do not count as unknown work", () => {
    const dir = repo();
    try {
      const example = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../examples/github-actions-step-plan.yml"), "utf8");
      write(dir, ".github/workflows/ci.yml", example);
      const skipped = plan(dir, { checks: [check("lint", "SKIP")], workflow: "ci.yml", mode: "enforce" });
      assert.equal(job(skipped, "diffci").decision, "run");
      assert.equal(job(skipped, "lint").decision, "skip");
      assert.equal(job(skipped, "test").decision, "skip");
      assert.equal(job(skipped, "build").decision, "run");
      // The step numbers the example's outputs name are the ones DiffCI writes.
      const gate = gatePlan({ tests: { selection: "selected", reason: "dependency impact", tests_selected: 1, tests_available: 10, selected_commands: ["node --test test/a.test.js"] } });
      const narrowed = githubOutput(plan(dir, { gate, checks: [check("lint", "NARROWED", "npx --no-install eslint src/a.ts")], workflow: "ci.yml", mode: "enforce" }));
      for (const name of ["lint_step_4", "test_step_4"]) {
        assert.match(narrowed, new RegExp(`^${name}<<`, "m"));
        assert.match(example, new RegExp(`steps\.plan\.outputs\.${name} }}`));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
