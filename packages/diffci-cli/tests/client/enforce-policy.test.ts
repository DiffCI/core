/**
 * Enforce mode step 1 (docs/enforce-mode-01-plan.md): every fallback that must force FULL, one fixture
 * each, plus the ordering between them and the CLI wiring end to end.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectEnforcementContext,
  evaluateEnforcement,
  FORCE_FULL_LABEL,
  type EnforcementContext,
} from "../../src/client/enforce-policy.js";
import { makeGitRunner } from "../../src/client/observe.js";
import type { ObservationReport, ObservationResult } from "../../src/client/report.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

const APPROVED = { policyVersion: 1, level: 1, approvedBy: "maintainer", approvedAt: "2026-10-01T00:00:00Z" };

function context(overrides: Partial<EnforcementContext> = {}): EnforcementContext {
  return {
    killSwitch: "on",
    pullRequestLabels: [],
    headCommitMessage: "change alpha\n",
    policy: APPROVED,
    range: { trusted: true },
    pathsRedacted: false,
    ...overrides,
  };
}

function observation(result: Partial<ObservationResult> = {}, report: Partial<ObservationReport> = {}): ObservationReport {
  return {
    status: "OBSERVED",
    payload: { includesFilePaths: true, includesFileContents: false, includesEnvironment: false, includesCredentials: false },
    result: {
      mode: "SELECTIVE",
      changedFileCount: 1,
      changedFiles: ["src/alpha.js"],
      selectedTests: ["test/alpha.test.js"],
      totalTestCount: 2,
      fallbackReasons: [],
      proposedCommands: ["node --test"],
      riskSignals: [],
      graph: { nodes: 4, edges: 2, confidence: "COMPLETE", effectiveConfidence: "COMPLETE", durationMs: 1 },
      ...result,
    },
    ...report,
  } as unknown as ObservationReport;
}

describe("evaluateEnforcement", () => {
  it("permits selection when every check passes", () => {
    const decision = evaluateEnforcement(context(), observation());
    assert.equal(decision.fired_fallback, null);
  });

  const cases: Array<[string, EnforcementContext, ObservationReport, string]> = [
    ["1 kill switch unset", context({ killSwitch: undefined }), observation(), "kill-switch"],
    ["1 kill switch not exactly on", context({ killSwitch: "true" }), observation(), "kill-switch"],
    ["2 force-full label", context({ pullRequestLabels: ["bug", FORCE_FULL_LABEL] }), observation(), "per-run-override"],
    ["2 commit trailer", context({ headCommitMessage: "fix\n\nDiffCI: full\n" }), observation(), "per-run-override"],
    ["3 no enforce block", context({ policy: undefined }), observation(), "policy-not-approved"],
    ["3 wrong policy version", context({ policy: { ...APPROVED, policyVersion: 2 } }), observation(), "policy-not-approved"],
    ["3 unapproved", context({ policy: { ...APPROVED, approvedBy: "" } }), observation(), "policy-not-approved"],
    ["4 open unsafe miss", context({ policy: { ...APPROVED, openUnsafeMisses: [{ test: "x" }] } }), observation(), "open-unsafe-miss"],
    ["5 untrusted range", context({ range: { trusted: false, reason: "force-push" } }), observation(), "untrusted-range"],
    ["6 analysis refused", context(), observation({}, { status: "REFUSED", reason: "no range", result: undefined }), "analysis-failure"],
    ["7 partial graph", context(), observation({ graph: { nodes: 1, edges: 0, confidence: "COMPLETE", effectiveConfidence: "PARTIAL", durationMs: 1 } }), "graph-confidence"],
    ["8 redacted paths", context({ pathsRedacted: true }), observation(), "global-risk"],
    ["8 critical risk signal", context(), observation({ riskSignals: [{ level: "critical", reason: "GLOBAL_CONFIG" }] }), "global-risk"],
    ["8 analyzer fell back", context(), observation({ mode: "FULL", fallbackReasons: ["lockfile changed"] }), "global-risk"],
    ["8 workflow file", context(), observation({ changedFiles: [".github/workflows/ci.yml"] }), "global-risk"],
    ["8 lockfile", context(), observation({ changedFiles: ["package-lock.json"] }), "global-risk"],
    ["8 test runner config", context(), observation({ changedFiles: ["packages/a/vitest.config.ts"] }), "global-risk"],
    ["8 diffci config", context(), observation({ changedFiles: ["diffci.config.json"] }), "global-risk"],
    ["9 empty selection on source change", context(), observation({ selectedTests: [] }), "empty-selection"],
  ];
  for (const [name, ctx, obs, expected] of cases) {
    it(`falls back: ${name}`, () => {
      assert.equal(evaluateEnforcement(ctx, obs).fired_fallback, expected);
    });
  }

  it("allows an empty selection when only documentation changed", () => {
    const decision = evaluateEnforcement(context(), observation({ selectedTests: [], changedFiles: ["README.md", "docs/guide.txt"] }));
    assert.equal(decision.fired_fallback, null);
  });

  it("reports the first fallback in order, not a later one", () => {
    const decision = evaluateEnforcement(
      context({ killSwitch: "off", policy: undefined, range: { trusted: false, reason: "x" } }),
      observation({ mode: "FULL" }),
    );
    assert.equal(decision.fired_fallback, "kill-switch");
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

/** `null` writes no diffci.config.json at all. */
function fixture(enforce: unknown = APPROVED): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-enforce-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@diffci.local");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  write(dir, "package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }));
  if (enforce !== null) write(dir, "diffci.config.json", JSON.stringify({ enforce }));
  write(dir, "src/alpha.js", "export const alpha = () => 1;\n");
  write(dir, "src/beta.js", "export const beta = () => 2;\n");
  write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 1));\n");
  write(dir, "test/beta.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {beta} from '../src/beta.js'; test('beta', () => assert.equal(beta(), 2));\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

function commit(dir: string, message: string, files: Record<string, string>): string {
  for (const [path, contents] of Object.entries(files)) write(dir, path, contents);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

const ALPHA_CHANGE = {
  "src/alpha.js": "export const alpha = () => 3;\n",
  "test/alpha.test.js": "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 3));\n",
};

function rangeObservation(baseSha: string, headSha: string, source = "explicit-flags"): ObservationReport {
  return observation({}, { commitRange: { baseSha, headSha, source } } as Partial<ObservationReport>);
}

describe("collectEnforcementContext", () => {
  it("reads the policy at the range base, so a change cannot approve itself", () => {
    const dir = fixture(null);
    try {
      const base = git(dir, "rev-parse", "HEAD");
      const head = commit(dir, "approve myself", { "diffci.config.json": JSON.stringify({ enforce: APPROVED }) });
      const ctx = collectEnforcementContext(makeGitRunner(dir), { DIFFCI_ENFORCE: "on" }, rangeObservation(base, head));
      assert.equal(ctx.policy, undefined);
      assert.equal(evaluateEnforcement(ctx, rangeObservation(base, head)).fired_fallback, "policy-not-approved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the force-full label from the pull request event and the trailer from the head commit", () => {
    const dir = fixture();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      const head = commit(dir, "change alpha\n\nDiffCI: full", ALPHA_CHANGE);
      const eventPath = join(dir, "..", `${dir.split(/[\\/]/).pop()}-event.json`);
      writeFileSync(eventPath, JSON.stringify({ pull_request: { labels: [{ name: FORCE_FULL_LABEL }] } }));
      try {
        const ctx = collectEnforcementContext(makeGitRunner(dir), { GITHUB_EVENT_PATH: eventPath }, rangeObservation(base, head));
        assert.deepEqual(ctx.pullRequestLabels, [FORCE_FULL_LABEL]);
        assert.match(ctx.headCommitMessage ?? "", /DiffCI: full/);
      } finally {
        rmSync(eventPath, { force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distrusts a base that is not an ancestor of head (force-push)", () => {
    const dir = fixture();
    try {
      const root = git(dir, "rev-parse", "HEAD");
      const abandoned = commit(dir, "abandoned", { "src/beta.js": "export const beta = () => 5;\n" });
      git(dir, "reset", "--quiet", "--hard", root);
      const head = commit(dir, "rewritten", ALPHA_CHANGE);
      const ctx = collectEnforcementContext(makeGitRunner(dir), {}, rangeObservation(abandoned, head, "push-event"));
      assert.equal(ctx.range.trusted, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distrusts a head-parent range and trusts an explicit one", () => {
    const dir = fixture();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      const head = commit(dir, "change alpha", ALPHA_CHANGE);
      const runner = makeGitRunner(dir);
      assert.equal(collectEnforcementContext(runner, {}, rangeObservation(base, head, "head-parent")).range.trusted, false);
      assert.equal(collectEnforcementContext(runner, {}, rangeObservation(base, head)).range.trusted, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function localTestEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && name !== "DIFFCI_ENFORCE" && !name.startsWith("GITHUB_")),
    ),
    ...extra,
  };
}

function runVerify(dir: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, "verify", "--repo", dir, "--json", ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 600_000, env: localTestEnv(env) },
  );
}

describe("verify --policy enforce", () => {
  it("runs the full suite when the kill switch is off", () => {
    const dir = fixture();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      const head = commit(dir, "change alpha", ALPHA_CHANGE);
      const run = runVerify(dir, ["--base", base, "--head", head, "--policy", "enforce"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.selection, "full");
      assert.equal(report.enforcement.fired_fallback, "kill-switch");
      assert.equal(report.enforcement.applied, false);
      assert.match(report.reason, /enforce fallback \(kill-switch\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs only the selected tests when every check passes", () => {
    const dir = fixture();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      const head = commit(dir, "change alpha", ALPHA_CHANGE);
      const run = runVerify(dir, ["--base", base, "--head", head, "--policy", "enforce"], { DIFFCI_ENFORCE: "on" });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.enforcement.fired_fallback, null, report.enforcement.detail);
      assert.equal(report.selection, "selected");
      assert.equal(report.enforcement.applied, true);
      assert.equal(report.tests_selected, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the full suite when package.json changes", () => {
    const dir = fixture();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      const head = commit(dir, "bump", {
        ...ALPHA_CHANGE,
        "package.json": JSON.stringify({ name: "fixture", version: "1.0.1", type: "module", scripts: { test: "node --test" } }),
      });
      const run = runVerify(dir, ["--base", base, "--head", head, "--policy", "enforce"], { DIFFCI_ENFORCE: "on" });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.selection, "full");
      assert.equal(report.enforcement.fired_fallback, "global-risk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves plain verify receipts without an enforcement block", () => {
    const dir = fixture();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      const head = commit(dir, "change alpha", ALPHA_CHANGE);
      const run = runVerify(dir, ["--base", base, "--head", head], { DIFFCI_ENFORCE: "on" });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(JSON.parse(run.stdout).enforcement, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown or missing policy value and --changed with a policy", () => {
    const dir = fixture();
    try {
      assert.equal(runVerify(dir, ["--policy", "strict"]).status, 2);
      assert.equal(runVerify(dir, ["--policy"]).status, 2);
      assert.equal(runVerify(dir, ["--changed", "--policy", "enforce"]).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
