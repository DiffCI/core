import assert from "node:assert/strict";
import { test } from "node:test";
import { formatVerificationSummary, type VerificationReport } from "../../src/client/verify.js";

function report(overrides: Partial<VerificationReport>): VerificationReport {
  return {
    schema: "diffci.verification.v1", schema_version: "1", produced_at: "2026-10-30T00:00:00Z", scope: "commit-range",
    verification: "failed", safe_to_continue: false, reason: "verification command failed with exit code 1",
    changed_files: 4, tests_available: 355, tests_selected: 136, selection: "selected",
    snapshot: { base_sha: "a".repeat(40), before_tree_sha: "b".repeat(40), unchanged: true },
    analysis: { status: "OBSERVED", fallback_reasons: [] }, required_actions: [],
    ...overrides,
  } as VerificationReport;
}

const measurement = { command: "npm test", exitCode: 1, signal: null, timedOut: false, startedAt: "", finishedAt: "", wallMs: 1 };

test("a failed run names its failing tests and the end of their output", () => {
  const text = formatVerificationSummary(report({
    execution: {
      ...measurement,
      stdoutTail: "✔ ok\n✖ authorization coverage inventory maps every API route (80ms)\n    at Test.run (node:internal)\nℹ fail 1\n",
      stderrTail: "",
      failingTests: ["authorization coverage inventory maps every API route", "src/lib/security/authorization-coverage.test.ts"],
    } as VerificationReport["execution"],
  }));
  assert.match(text, /failing tests: authorization coverage inventory maps every API route, src\/lib\/security\/authorization-coverage\.test\.ts/);
  assert.match(text, /output \(last lines\):\n {4}✔ ok\n {4}✖ authorization coverage/);
  assert.doesNotMatch(text, /at Test\.run|ℹ fail/);
});

test("a failed check shows its error message", () => {
  const text = formatVerificationSummary(report({
    reason: "gate check check:cloudflare-api-shield failed with exit code 1",
    execution: {
      ...measurement,
      stdoutTail: "> node scripts/generate-cloudflare-api-shield-schema.mjs --check\n",
      stderrTail: "Error: ops/cloudflare/api-shield.openapi.json is stale; run npm run cloudflare:api-shield:schema.\n    at file:///x.mjs:131:13\n\nNode.js v24.16.0\n",
    } as VerificationReport["execution"],
  }));
  assert.match(text, /\n {4}Error: ops\/cloudflare\/api-shield\.openapi\.json is stale/);
  assert.doesNotMatch(text, /Node\.js v24|at file:/);
});

test("a passing run adds no failure lines", () => {
  const text = formatVerificationSummary(report({
    verification: "passed", safe_to_continue: true, reason: "dependency impact",
    execution: { ...measurement, exitCode: 0, stdoutTail: "ℹ pass 3\n", stderrTail: "" } as VerificationReport["execution"],
  }));
  assert.doesNotMatch(text, /failing tests|output \(last lines\)/);
});
