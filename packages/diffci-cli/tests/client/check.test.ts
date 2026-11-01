import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { inferFullCommand, inferSelectedCommand, inferComparableSelectedCommand, inferWorkspaceComparison } from "../../src/client/full-command.js";
import { analyzeRepository } from "@diffci.com/core/repo/analyzer";
import { commandSpecToString, planSelectiveTestCommands } from "@diffci.com/core/planner/test-command";

import { measureCommand, runVerifySavings } from "../../src/client/verify-savings.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe("automatic check timing", () => {
  it("binds a verified multi-command override to observation provenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-multi-"));
    try {
      git(dir, "init"); git(dir, "config", "user.email", "fixture@example.com"); git(dir, "config", "user.name", "Fixture");
      write(dir, "package.json", JSON.stringify({ name: "fixture" }));
      git(dir, "add", "package.json"); git(dir, "commit", "-m", "fixture");
      const path = join(dir, "observation.json");
      write(dir, "observation.json", JSON.stringify({ status: "OBSERVED", commitRange: { headSha: git(dir, "rev-parse", "HEAD") }, result: { proposedCommands: ["node --version", "node --version"], selectedTests: ["a.test.ts"], totalTestCount: 2 }, timings: { totalMs: 1 } }));
      const options = { full: "node --version", selectedFromReport: path, out: join(dir, "savings.json"), cwd: dir, timeoutMs: 10000, tailBytes: 1000 };
      assert.throws(() => runVerifySavings(options), /exactly one/);
      const result = runVerifySavings({ ...options, selectedCommandOverride: "node --version && node --version" });
      assert.equal(result.comparison.evidenceValid, true);
      assert.equal(result.selectionSource, "diffci-observation");
      assert.equal(result.provenance.headSha, git(dir, "rev-parse", "HEAD"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("compares complete workspace plans and rejects modified report commands or root hooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-workspace-"));
    try {
      write(dir, "package.json", JSON.stringify({ scripts: { test: "pnpm -r run test" } }));
      write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'");
      write(dir, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
      for (const name of ["a", "b"]) {
        write(dir, `packages/${name}/package.json`, JSON.stringify({ scripts: { test: "vitest --typecheck" }, devDependencies: { vitest: "4.1.8" } }));
        write(dir, `packages/${name}/src/value.test.ts`, "export const value=1;");
      }
      const paths = ["packages/a/src/value.test.ts"];
      const proposed = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), paths).commands.map(commandSpecToString);
      const pair = inferWorkspaceComparison(dir, proposed, paths);
      assert.equal(pair.full, "pnpm test");
      assert.ok(pair.selected?.includes("packages/a exec vitest run src/value.test.ts"));
      assert.ok(pair.selected?.includes("packages/b exec vitest run --typecheck.only --passWithNoTests"));
      assert.equal(inferWorkspaceComparison(dir, [...proposed, "echo fake"], paths).selected, undefined);
      write(dir, "package.json", JSON.stringify({ scripts: { test: "pnpm -r run test", pretest: "node setup.js" } }));
      assert.equal(inferWorkspaceComparison(dir, proposed, paths).selected, undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("executes package-script chains and preserves failure short-circuiting", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-chain-"));
    try {
      write(dir, "pass.cjs", "require('node:fs').appendFileSync('phases.txt', 'pass\\n');");
      write(dir, "fail.cjs", "process.exit(7);");
      const options = { cwd: dir, timeoutMs: 10000, tailBytes: 1000 };
      assert.equal(measureCommand("node pass.cjs && node pass.cjs", options).exitCode, 0);
      assert.equal(readFileSync(join(dir, "phases.txt"), "utf8"), "pass\npass\n");
      assert.equal(measureCommand("node -e \"require('node:fs').writeFileSync('quoted.txt','changed')\"", options).exitCode, 0);
      assert.equal(readFileSync(join(dir, "quoted.txt"), "utf8"), "changed");
      assert.equal(measureCommand("node fail.cjs && node pass.cjs", options).exitCode, 7);
      assert.equal(readFileSync(join(dir, "phases.txt"), "utf8"), "pass\npass\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("preserves Immer build and Flow phases and UFO lint and type checking", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-scope-"));
    try {
      write(dir, "package.json", JSON.stringify({ scripts: { test: "vitest run && yarn test:build && yarn test:flow" } }));
      assert.equal(inferComparableSelectedCommand(dir, "yarn run vitest run --config vitest.config.ts a.test.ts", ["a.test.ts"]).command,
        "yarn run vitest run --config vitest.config.ts a.test.ts && yarn test:build && yarn test:flow");
      write(dir, "package.json", JSON.stringify({ scripts: { test: "pnpm lint && vitest run --typecheck" } }));
      assert.equal(inferComparableSelectedCommand(dir, "pnpm exec vitest run a.test.ts", ["a.test.ts"]).command,
        "pnpm lint && pnpm exec vitest run a.test.ts --typecheck");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("withholds automatic timing when scope or lifecycle hooks cannot be preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-scope-refusal-"));
    try {
      for (const scripts of [
        { test: "vitest --coverage" },
        { test: "vitest run --project unit" },
        { test: "vitest run && vitest run --config integration.ts" },
        { test: "echo setup && vitest run" },
        { test: "vitest run", pretest: "node setup.js" },
        { test: "vitest run", posttest: "node audit.js" },
      ]) {
        write(dir, "package.json", JSON.stringify({ scripts }));
        assert.equal(inferComparableSelectedCommand(dir, "pnpm exec vitest run a.test.ts", ["a.test.ts"]).command, undefined, JSON.stringify(scripts));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the declared tsx loader for selected TypeScript tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-tsx-"));
    try {
      write(dir, "package.json", JSON.stringify({ scripts: { test: 'node --test tests/a.test.mjs && tsx --conditions react-server --test "src/**/*.test.ts"' } }));
      assert.deepEqual(inferSelectedCommand(dir, "node --test src/a.test.ts", ["src/a.test.ts"]), {
        command: "npx --no-install tsx --conditions react-server --test src/a.test.ts",
        reason: "TypeScript node:test runner from package.json test script",
      });
      assert.equal(inferSelectedCommand(dir, "node --test tests/a.test.mjs", ["tests/a.test.mjs"]).command, "node --test tests/a.test.mjs");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("infers a Maven command with the same configured goal and profiles as selection", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-full-maven-"));
    try {
      write(dir, "pom.xml", "<project/>");
      write(dir, "diffci.json", JSON.stringify({ maven: { goal: "verify", profiles: ["run-its"] } }));
      assert.deepEqual(inferFullCommand(dir), {
        command: "mvn -P run-its verify",
        reason: "Maven goal and profiles from DiffCI configuration",
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs inferred full and selected test commands and writes a savings report", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-check-exec-"));
    const out = join(tmpdir(), `diffci-check-${Date.now()}-${process.pid}.json`);
    try {
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
      const base = git(dir, "rev-parse", "HEAD");
      write(dir, "src/alpha.js", "export const alpha = () => 3;\n");
      write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 3));\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "change alpha");
      const head = git(dir, "rev-parse", "HEAD");

      const run = spawnSync(process.execPath, ["--import", "tsx", CLI, "check", "--repo", dir, "--base", base, "--head", head, "--out", out], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /running full and selected validation/);
      assert.match(run.stdout, /DiffCI verify-savings: .*%/);
      const savingsPath = out.replace(/\.json$/, "-savings.json");
      assert.equal(existsSync(savingsPath), true);
      const savings = JSON.parse(readFileSync(savingsPath, "utf8"));
      assert.equal(savings.full.exitCode, 0);
      assert.equal(savings.selected.exitCode, 0);
      assert.equal(savings.full.command, "npm test");
      assert.match(savings.selected.command, /node --test/);
      assert.equal(savings.schema, "diffci.verifySavings.v3");
      assert.equal(savings.protocol.repetitions, 1);
      assert.equal(savings.comparison.performanceEvidence, "PRELIMINARY");
      assert.match(savings.runnerIdentity.fingerprintSha256, /^[a-f0-9]{64}$/);
      assert.equal(savings.provenance.baseSha, base);
      assert.equal(savings.provenance.headSha, head);
      assert.match(savings.provenance.observationSha256, /^[a-f0-9]{64}$/);
      assert.equal(savings.provenance.beforeFull.headSha, head);
      assert.equal(savings.provenance.afterFull.headSha, head);
      assert.equal(savings.provenance.afterSelected.headSha, head);
      assert.equal(savings.provenance.checkoutStable, true);
      assert.equal(savings.comparison.evidenceValid, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const path of [out, out.replace(/\.json$/, "-savings.json"), out.replace(/\.json$/, "-savings.md")]) {
        try { rmSync(path, { force: true }); } catch { /* best effort */ }
      }
    }
  });
});
