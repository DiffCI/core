import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendOutcome, outcomeLogPath, readOutcomes, summarizeOutcomes } from "../../src/client/outcome-log.js";
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

test("outside a Git repository there is no log and nothing is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-outcomes-nogit-"));
  try {
    assert.equal(outcomeLogPath(dir), undefined);
    assert.equal(appendOutcome(dir, report({ tree: "t" }), {}), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
