import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendOutcome, outcomeLogPath, readOutcomes, reusablePass, summarizeOutcomes, type OutcomeRecord, type ReuseQuery } from "../../src/client/outcome-log.js";
import type { VerificationReport } from "../../src/client/verify.js";

function report(fields: Partial<VerificationReport> & { tree: string; failing?: string[]; wallMs?: number }): VerificationReport {
  const { tree, failing, wallMs = 1000, ...rest } = fields;
  return {
    schema: "diffci.verification.v1", schema_version: "1", produced_at: new Date().toISOString(), diffci_version: "test",
    scope: "working-tree", verification: "passed", safe_to_continue: true, reason: "", changed_files: 1,
    tests_available: 4, tests_selected: 1, selection: "selected",
    execution: { command: "node --test", exitCode: rest.verification === "failed" ? 1 : 0, signal: null, timedOut: false, startedAt: "", finishedAt: "", wallMs, stdoutTail: "", stderrTail: "", ...(failing ? { failingTests: failing } : {}) },
    snapshot: { base_sha: "b".repeat(40), before_tree_sha: tree, unchanged: true },
    analysis: { status: "OBSERVED", fallback_reasons: [] }, required_actions: [],
    ...rest,
  };
}

test("verify runs are appended inside .git and summarised, with possible misses", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-outcomes-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    const path = outcomeLogPath(dir)!;
    assert.match(path.replaceAll("\\", "/"), /\/\.git\/diffci\/outcomes\.jsonl$/);

    assert.equal(appendOutcome(dir, report({ tree: "t1" }), { DIFFCI_OUTCOME_LOG: "0" }), undefined, "opting out writes nothing");
    assert.equal(existsSync(path), false);

    appendOutcome(dir, report({ tree: "t1", selected_tests: ["a.test.js"], selection_reasons: { "a.test.js": { reason: "DEPENDENCY", changed_file: "a.js" } }, wallMs: 2000 }), { CLAUDECODE: "1" });
    appendFileSync(path, "not json\n");
    appendOutcome(dir, report({ tree: "t1", selection: "full", tests_selected: 4, verification: "failed", safe_to_continue: false, failing: ["b fails"], wallMs: 9000,
      analysis: { status: "OBSERVED", fallback_reasons: ["Unknown changed file: x.cfg"] } }), {});
    appendOutcome(dir, report({ tree: "t2", selection: "full", tests_selected: 4, verification: "failed", safe_to_continue: false }), {});

    const records = readOutcomes(path);
    assert.equal(records.length, 3, "the malformed line is skipped");
    assert.deepEqual(records[0]!.selection_reasons, { "a.test.js": { reason: "DEPENDENCY", changed_file: "a.js" } });
    assert.equal(records[0]!.agent, "claude");

    const summary = summarizeOutcomes(records);
    assert.equal(summary.runs, 3);
    assert.equal(summary.selected, 1);
    assert.equal(summary.full, 2);
    assert.equal(summary.median_selected_ms, 2000);
    assert.deepEqual(summary.top_fallback_reasons, [{ reason: "Unknown changed file: x.cfg", runs: 1 }]);
    // Only t1 had a passing selected run before its failing full run; t2 never ran selected.
    assert.equal(summary.possible_misses.length, 1);
    assert.equal(summary.possible_misses[0]!.tree_sha, "t1");
    assert.deepEqual(summary.possible_misses[0]!.failing_tests, ["b fails"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuses only a covering pass of the same tree under the same versions", () => {
  const run = (fields: Partial<OutcomeRecord>): OutcomeRecord => ({
    schema: "diffci.outcome.v1", produced_at: "2026-11-06T00:00:00.000Z", diffci_version: "1.0.0", node_version: "24.0.0",
    scope: "working-tree", base_sha: "b", tree_sha: "t1", verification: "passed", selection: "full", tests_selected: 3, tests_available: 3,
    fallback_reasons: [], command: "npm test", ...fields,
  });
  const query: ReuseQuery = {
    tree_sha: "t1", diffci_version: "1.0.0", node_version: "24.0.0", selection: "selected", selected_tests: ["a.test.js"],
    command: "node --test a.test.js", full_command: "npm test", checks: [],
  };
  assert.equal(reusablePass([run({})], query)?.command, "npm test", "a full pass covers any selection");
  assert.equal(reusablePass([run({ tree_sha: "t2" })], query), undefined, "another tree");
  assert.equal(reusablePass([run({ verification: "failed" })], query), undefined, "failures are never reused");
  assert.equal(reusablePass([run({ node_version: "22.0.0" })], query), undefined, "another Node version");
  assert.equal(reusablePass([run({ diffci_version: "0.9.0" })], query), undefined, "another DiffCI version");
  assert.equal(reusablePass([run({ command: "npm run test:all" })], query), undefined, "another full command");
  assert.equal(reusablePass([run({ reused_from: "2026-11-05T00:00:00.000Z" })], query), undefined, "a reused run is not a source");

  const selected = (tests: string[]) => run({ selection: "selected", selected_tests: tests, command: `node --test ${tests.join(" ")}` });
  assert.ok(reusablePass([selected(["a.test.js", "b.test.js"])], query), "a selected pass covering every selected test");
  assert.equal(reusablePass([selected(["b.test.js"])], query), undefined, "a selected pass missing one");
  assert.equal(reusablePass([selected(["a.test.js"])], { ...query, selection: "full", command: "npm test" }), undefined, "a selection never covers a full run");

  const lint = { id: "lint", command: "eslint src/a.js" };
  const withChecks = { ...query, checks: [lint] };
  assert.equal(reusablePass([run({})], withChecks), undefined, "a check this run would execute must have passed");
  assert.equal(reusablePass([run({ checks: [{ id: "lint", decision: "NARROWED", status: "passed", command: "eslint src/b.js" }] })], withChecks), undefined, "narrowed to other files");
  assert.ok(reusablePass([run({ checks: [{ id: "lint", decision: "NARROWED", status: "passed", command: "eslint src/a.js" }] })], withChecks));
  assert.equal(reusablePass([run({}), run({ produced_at: "2026-11-06T01:00:00.000Z" })], query)?.produced_at, "2026-11-06T01:00:00.000Z", "the newest pass");
});

test("outside a Git repository there is no log and nothing is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-outcomes-nogit-"));
  try {
    assert.equal(outcomeLogPath(dir), undefined);
    assert.equal(appendOutcome(dir, report({ tree: "t" }), {}), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
