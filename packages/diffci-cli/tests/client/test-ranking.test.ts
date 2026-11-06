import assert from "node:assert/strict";
import { test } from "node:test";
import { orderCommand, splitCommand } from "../../src/client/command-batches.js";
import type { OutcomeRecord } from "../../src/client/outcome-log.js";
import { confidenceCurve, failureScore, formatConfidenceCurve, likelyFailures, rankTests, testHistory } from "../../src/client/test-ranking.js";
import type { TestFileResult } from "../../src/client/test-results.js";

function run(results: TestFileResult[], fields: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    schema: "diffci.outcome.v1", produced_at: "2026-11-06T00:00:00.000Z", scope: "working-tree", base_sha: "b", tree_sha: "t",
    verification: results.some((result) => result.status === "failed") ? "failed" : "passed", selection: "full",
    tests_selected: results.length, tests_available: results.length, fallback_reasons: [], test_results: results, ...fields,
  };
}
const pass = (file: string, ms = 10): TestFileResult => ({ file, status: "passed", ms });
const fail = (file: string, ms = 10): TestFileResult => ({ file, status: "failed", ms });

test("ranks tests that failed recently first, then faster ones, then the given order", () => {
  const history = testHistory([
    run([fail("b.test.js"), pass("a.test.js", 50), pass("c.test.js", 5)]),
    run([pass("b.test.js"), pass("a.test.js", 50), pass("c.test.js", 5)]),
  ]);
  assert.deepEqual(rankTests(["a.test.js", "b.test.js", "c.test.js", "new.test.js"], history), ["b.test.js", "c.test.js", "a.test.js", "new.test.js"]);
  assert.deepEqual(likelyFailures(["a.test.js", "b.test.js"], history), ["b.test.js"]);
});

test("weights recent failures over old ones", () => {
  const old = Array.from({ length: 30 }, (_, index) => run([index === 0 ? fail("old.test.js") : pass("old.test.js"), index === 29 ? fail("recent.test.js") : pass("recent.test.js")]));
  const history = testHistory(old);
  assert.ok(failureScore("recent.test.js", history) > failureScore("old.test.js", history));
});

test("a test the change edited or added ranks with the likeliest", () => {
  const history = testHistory([]);
  assert.equal(failureScore("a.test.js", history, { reason: "DIRECT_TEST_CHANGE", changed_file: "a.test.js" }), 1);
  assert.equal(failureScore("a.test.js", history, { reason: "DEPENDENCY", changed_file: "a.js" }), 0);
});

test("reorders and splits only a command that ends in exactly the selected paths", () => {
  const paths = ["a.test.js", "src/app/[id]/b.test.js", "c.test.js"];
  const command = 'node --test a.test.js "src/app/@([[])id@([]])/b.test.js" c.test.js';
  assert.equal(orderCommand(command, ["c.test.js", "src/app/[id]/b.test.js", "a.test.js"]), 'node --test c.test.js "src/app/@([[])id@([]])/b.test.js" a.test.js');
  assert.deepEqual(splitCommand(command, paths, ["c.test.js"]), ["node --test c.test.js", 'node --test a.test.js "src/app/@([[])id@([]])/b.test.js"']);
  assert.deepEqual(splitCommand(command, paths, paths), [command], "nothing would be left for the second part");
  assert.equal(orderCommand("npm test -- --reporter dot", paths), "npm test -- --reporter dot", "not understood, so unchanged");
});

test("the confidence curve ranks each failing run only by the runs before it", () => {
  const records = [
    run([fail("slow.test.js", 10), pass("a.test.js", 80)]),
    // Path order runs a.test.js (80) before slow.test.js; history puts slow.test.js first.
    run([pass("a.test.js", 80), fail("slow.test.js", 20)]),
  ];
  const curve = confidenceCurve(records, 4);
  assert.equal(curve.failing_runs, 2);
  // The first run has no history, so both orders are path order: a.test.js (80 of 90) runs first.
  assert.equal(curve.median_by_path, (80 / 90 + 80 / 100) / 2);
  assert.equal(curve.median_ranked, (80 / 90 + 0) / 2);
  assert.deepEqual(curve.ranked.map((point) => point.detected_share), [0.5, 0.5, 0.5, 1]);
  assert.deepEqual(curve.by_path.map((point) => point.detected_share), [0, 0, 0, 1]);
  assert.match(formatConfidenceCurve(curve), /2 failing run\(s\)[\s\S]*early signal/);
  assert.match(formatConfidenceCurve(confidenceCurve([run([pass("a.test.js")])])), /no failing run/);
});
