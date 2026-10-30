import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatGateSummary, gateExitCode, runGate, type GateOptions } from "../../src/client/gate.js";
import type { ObservationReport } from "../../src/client/report.js";
import type { CommandMeasurement } from "../../src/client/verify-savings.js";

/** A repository whose last commit changes one source file: lint narrows to it, the docs check skips. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "diffci-gate-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: { check: "npm run lint && node scripts/docs.mjs", lint: "eslint \"src/**/*.ts\"", test: "node --test" },
  }));
  writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "docs", "guide.md"), "x\n");
  writeFileSync(join(dir, "scripts", "docs.mjs"), "import { readFileSync } from \"node:fs\";\nreadFileSync(\"docs/guide.md\");\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  git("commit", "-qam", "code");
  return { dir, base, head: git("rev-parse", "HEAD") };
}

function measurement(command: string, exitCode: number, wallMs: number): CommandMeasurement {
  return { command, exitCode, signal: null, timedOut: false, startedAt: "", finishedAt: "", wallMs, stdoutTail: "", stderrTail: "" };
}

function options(repo: ReturnType<typeof fixture>, failing: (command: string) => boolean, extra: Partial<GateOptions> = {}) {
  const ran: string[] = [];
  const durations: Record<string, number> = { "npm run lint": 4000, "node scripts/docs.mjs": 2000, "npm test": 10_000 };
  const opts: GateOptions = {
    repoPath: repo.dir, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 0,
    run: (command) => { ran.push(command); return measurement(command, failing(command) ? 1 : 0, durations[command] ?? 1000); },
    analyse: async () => ({
      status: "OBSERVED",
      commitRange: { baseSha: repo.base, headSha: repo.head, source: "explicit" },
      timings: { totalMs: 500 },
      result: { mode: "SELECTIVE", selectedTests: ["src/a.test.js"], totalTestCount: 4, fallbackReasons: [], proposedCommands: ["node --test src/a.test.js"] },
    }) as unknown as ObservationReport,
    ...extra,
  };
  return { opts, ran };
}

test("a passing build runs the full gate once and estimates what DiffCI would have saved", async () => {
  const repo = fixture();
  try {
    const { opts, ran } = options(repo, () => false);
    const report = await runGate(opts);
    assert.deepEqual(ran, ["npm run lint", "node scripts/docs.mjs", "npm test"]);
    assert.deepEqual(report.checks.map((c) => [c.id, c.decision]), [["lint", "NARROWED"], ["check[2]", "SKIP"]]);
    assert.equal(report.checks[0]!.narrowed_command, "npx --no-install eslint src/a.ts");
    assert.equal(report.tests?.selection, "selected");
    assert.equal(gateExitCode(report), 0);
    // Full 16s; DiffCI: 0.5s analysis + 4s lint (narrowed, counted at full time) + 10s * 1/4 tests.
    assert.deepEqual(report.summary, { full_ms: 16_000, diffci_ms: 7000, saved_ms: 9000, basis: "estimated", misses: [] });
    assert.match(formatGateSummary(report), /would save 9\.0s/);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

test("--measure-selected times DiffCI's own steps instead of estimating", async () => {
  const repo = fixture();
  try {
    const { opts, ran } = options(repo, () => false, { measureSelected: true });
    const report = await runGate(opts);
    assert.deepEqual(ran.slice(3), ["npx --no-install eslint src/a.ts", "node --test src/a.test.js"]);
    assert.equal(report.summary.basis, "measured");
    assert.equal(report.summary.diffci_ms, 500 + 1000 + 1000);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

test("a failing step DiffCI would have skipped or narrowed away is a miss, and the build still fails", async () => {
  const repo = fixture();
  try {
    const { opts, ran } = options(repo, (command) => command === "node scripts/docs.mjs" || command === "npm run lint");
    const report = await runGate(opts);
    assert.equal(gateExitCode(report), 1);
    assert.deepEqual(report.summary.misses, ["lint", "check[2]"]);
    assert.ok(ran.includes("npx --no-install eslint src/a.ts"), "the narrowed lint reran to attribute the failure");
    assert.match(formatGateSummary(report), /MISSES: lint, check\[2\]/);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

test("a test failure the selection also catches is not a miss", async () => {
  const repo = fixture();
  try {
    const { opts } = options(repo, (command) => command === "npm test" || command.includes("--test"));
    const report = await runGate(opts);
    assert.equal(report.tests?.full.status, "failed");
    assert.equal(report.tests?.selected?.status, "failed");
    assert.equal(report.tests?.missed, false);
    assert.deepEqual(report.summary.misses, []);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

test("a failed analysis still runs and reports the full gate", async () => {
  const repo = fixture();
  try {
    const { opts, ran } = options(repo, () => false, { analyse: async () => { throw new Error("boom"); } });
    const report = await runGate(opts);
    assert.deepEqual(ran, ["npm run lint", "node scripts/docs.mjs", "npm test"]);
    assert.equal(report.analysis.status, "ERROR");
    assert.ok(report.checks.every((c) => c.decision === "UNPLANNED"));
    assert.equal(report.tests?.selection, "unavailable");
    assert.equal(report.summary.saved_ms, 0);
    assert.equal(gateExitCode(report), 0);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});
