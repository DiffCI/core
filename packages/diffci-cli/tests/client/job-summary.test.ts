import assert from "node:assert/strict";
import { test } from "node:test";
import { formatJobSummary } from "../../src/client/job-summary.js";
import type { ObservationReport } from "../../src/client/report.js";
import { makeReport } from "../helpers/report-fixture.js";

function withResult(overrides: Partial<NonNullable<ObservationReport["result"]>>): ObservationReport {
  const report = makeReport();
  return { ...report, result: { ...report.result!, ...overrides } };
}

test("a selective plan leads with what the change affects and why", () => {
  const text = formatJobSummary(withResult({
    selectionReasons: { "test/alpha.test.ts": { reason: "DIRECT_IMPORT", changed_file: "src/alpha.ts" } },
  }), "raw summary");
  assert.match(text, /^### DiffCI: what this change affects/);
  assert.match(text, /\*\*1 of 12 test files\*\* is affected by 1 changed file\./);
  assert.match(text, /A simple path-rule CI would have run everything\./);
  assert.match(text, /\| `test\/alpha\.test\.ts` \| direct import from `src\/alpha\.ts` \|/);
  assert.match(text, /npx --no-install vitest run test\/alpha\.test\.ts/);
  assert.match(text, /<summary>Full report<\/summary>\n\n```\nraw summary\n```/);
  assert.match(text, /Observation only: DiffCI ran, skipped and changed nothing in this job/);
});

test("a full-suite fallback says so and gives its reasons", () => {
  const text = formatJobSummary(withResult({
    mode: "FULL", selectedTests: [], fallbackReasons: ["package.json changed"],
  }), "raw");
  assert.match(text, /\*\*The full test suite is needed\*\* for 1 changed file/);
  assert.match(text, /- package\.json changed/);
  assert.doesNotMatch(text, /Why these/);
});

test("a refusal names no plan and keeps the reason", () => {
  const text = formatJobSummary(makeReport({ status: "REFUSED", stage: "delta", reason: "shallow clone", result: undefined } as Partial<ObservationReport>), "raw");
  assert.match(text, /\*\*No plan for this change\*\* \(refused at delta\)\./);
  assert.match(text, /shallow clone/);
});

test("long selections collapse and paths cannot break the table", () => {
  const tests = Array.from({ length: 25 }, (_u, i) => `t|${i}.test.ts`);
  const text = formatJobSummary(withResult({ selectedTests: tests, totalTestCount: 40 }), "raw");
  assert.match(text, /\| `t\\\|0\.test\.ts` \| affected by the change \|/);
  assert.match(text, /\| and 5 more \| see the report artifact \|/);
  assert.doesNotMatch(text, /t\|24/);
});

test("a changed worktree and a failed delivery are shown outside the collapsed report", () => {
  const report = makeReport();
  const text = formatJobSummary(
    { ...report, nonInterference: { ...report.nonInterference, worktreeUnchanged: false } },
    "raw",
    "not sent (network): timeout",
  );
  const collapsed = text.indexOf("<summary>Full report");
  assert.ok(text.indexOf("The working tree changed") < collapsed);
  assert.ok(text.indexOf("Delivery: not sent (network): timeout") < collapsed);
});
