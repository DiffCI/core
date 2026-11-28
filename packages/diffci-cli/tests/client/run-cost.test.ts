import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { OUTCOME_SCHEMA, type OutcomeRecord } from "../../src/client/outcome-log.js";
import { estimateRunCost, formatRunCost } from "../../src/client/run-cost.js";

function record(fields: Partial<OutcomeRecord>): OutcomeRecord {
  return {
    schema: OUTCOME_SCHEMA, produced_at: "2026-11-27T00:00:00.000Z", scope: "working-tree", base_sha: "a", tree_sha: "t",
    verification: "passed", selection: "full", tests_selected: 0, tests_available: 0, fallback_reasons: [], ...fields,
  };
}

// DentalPresence, 2026-11-27: the full suite takes 217s, a selection of heavy D1 files far longer.
const full = record({ tests_ms: 217_000, test_results: [{ file: "src/a.test.ts", status: "passed", ms: 100_000 }, { file: "src/b.test.ts", status: "passed", ms: 117_000 }] });
const heavy = record({ selection: "selected", tests_ms: 640_000, test_results: [{ file: "scripts/d1-x.test.ts", status: "passed", ms: 300_000 }, { file: "scripts/d1-y.test.ts", status: "passed", ms: 340_000 }] });

describe("estimateRunCost", () => {
  it("says a selection costs more than the full suite, and how much ran outside it", () => {
    const cost = estimateRunCost([full, heavy], ["src/a.test.ts"], ["scripts/d1-x.test.ts", "scripts/d1-y.test.ts"], 650_000)!;
    assert.deepEqual(cost, {
      selected_file_ms: 740_000, outside_suite_file_ms: 640_000, untimed_files: 0,
      full_file_ms: 217_000, full_wall_ms: 217_000, actual_wall_ms: 650_000, exceeds_full: true,
    });
    const line = formatRunCost(cost, 2)!;
    assert.match(line, /cost MORE than the full suite/);
    assert.match(line, /test time 740\.0s vs 217\.0s/);
    assert.match(line, /2 file\(s\) outside the full test command ran in addition to it \(640\.0s\)/);
  });

  it("reports a real saving without a warning", () => {
    const cost = estimateRunCost([full], ["src/a.test.ts"], [], 90_000)!;
    assert.equal(cost.exceeds_full, false);
    assert.equal(formatRunCost(cost, 0), "  cost: test time 100.0s vs 217.0s for the full suite; this run 90.0s vs 217.0s median full run");
  });

  it("counts untimed files instead of guessing them, as a lower bound", () => {
    const cost = estimateRunCost([full], ["src/a.test.ts", "src/new.test.ts"], [])!;
    assert.equal(cost.untimed_files, 1);
    assert.match(formatRunCost(cost, 0)!, /at least 100\.0s \(1 file\(s\) untimed\)/);
  });

  it("ignores failed, reused and selected runs as the full baseline", () => {
    const records = [record({ verification: "failed", tests_ms: 5 }), record({ reused_from: "x", tests_ms: 5 }), heavy];
    assert.equal(estimateRunCost(records, ["src/a.test.ts"], [], 10), undefined);
  });
});
