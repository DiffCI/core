// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ENGINE_COVERAGE_01 item 1 — time-boxed dependency resolution.
 *
 * DEPENDENCY_BASIS_TIME_BOXED is a distinct, WEAKER claim than DEPENDENCY_BASIS_PINNED: "a defensible
 * historical basis to attempt this operation", never "the exact dependency graph CI originally
 * installed". These tests exist to keep that boundary real in code, not just in the plan
 * (docs/engine-coverage-01-item-1-implementation-plan.md) that specified it — in particular the six
 * negative cases §6/§8 of that plan made mandatory, and the guarantee that an already-pinned repository's
 * receipts stay byte-for-byte unchanged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { timeBoxedDependencyBasis } from "../../src/ci-inference/resolve.js";
import { computeCompleteness } from "../../src/ci-inference/reference-graph.js";
import { inferPipeline } from "../../src/ci-inference/infer.js";
import type { ObservedFact } from "../../src/ci-inference/schema.js";

const NOW = "2026-09-04T00:00:00.000Z";
const NONEXISTENT_REPO = "C:/__diffci-time-boxing-test-fixture-does-not-exist__";
const CUTOFF = "2026-09-01T08:25:03Z";

function fact(partial: Partial<ObservedFact> & Pick<ObservedFact, "kind" | "value">): ObservedFact {
  return { evidence: { file: ".github/workflows/ci.yml", text: partial.value }, ...partial };
}

const RUN_STEP = (value: string) => fact({ kind: "workflow.step.run", value, attributes: { workflow: "ci.yml", job: "test", step: "0" } });

// ---------------------------------------------------------------------------------------------
// resolve.ts's timeBoxedDependencyBasis — direct unit tests, the six required negative cases first
// ---------------------------------------------------------------------------------------------

test("negative case 1: no cutoff supplied — never established, never defaults to anything", () => {
  const result = timeBoxedDependencyBasis([], undefined);
  assert.equal(result.established, false);
  assert.match(result.detail, /no independently-sourced historical cutoff supplied/);
});

test("an invalid cutoff string is refused, not silently coerced", () => {
  const result = timeBoxedDependencyBasis([], "not-a-date");
  assert.equal(result.established, false);
  assert.match(result.detail, /not a valid ISO-8601 timestamp/);
});

test("negative case 5: a non-npm packageManager field refuses time-boxing outright", () => {
  const facts: ObservedFact[] = [fact({ kind: "package.packageManager", value: "yarn@1.22.22" })];
  const result = timeBoxedDependencyBasis(facts, CUTOFF);
  assert.equal(result.established, false);
  assert.match(result.detail, /npm only in this phase/);
});

test("a valid cutoff with no conflicting packageManager field is established", () => {
  const result = timeBoxedDependencyBasis([], CUTOFF);
  assert.equal(result.established, true);
  assert.equal(result.cutoff, CUTOFF);
  assert.match(result.detail, /bounded to versions published on or before/);
});

test("an npm packageManager field does not block time-boxing", () => {
  const facts: ObservedFact[] = [fact({ kind: "package.packageManager", value: "npm@10.2.4" })];
  const result = timeBoxedDependencyBasis(facts, CUTOFF);
  assert.equal(result.established, true);
});

// ---------------------------------------------------------------------------------------------
// reference-graph.ts's either/or slot mechanics
// ---------------------------------------------------------------------------------------------

test("an already-pinned install operation's checks are byte-for-byte unchanged: TIME_BOXED is never evaluated", () => {
  const completeness = computeCompleteness(
    "install",
    {
      DEPENDENCY_BASIS_PINNED: { satisfied: true, observed: "lockfile package-lock.json" },
      COMMAND_RESOLVED: { satisfied: true, observed: "argv of 2 token(s)" },
      WORKING_DIRECTORY_KNOWN: { satisfied: true, observed: "repository root" },
      // Present in observations, exactly as infer.ts unconditionally computes it — but must never appear
      // in checks/executable reasoning here, since PINNED already satisfied the slot.
      DEPENDENCY_BASIS_TIME_BOXED: { satisfied: true, observed: "install bounded to versions published on or before 2026-09-01T08:25:03Z (npm --before)" },
    },
    [],
  );
  assert.equal(completeness.executable, true);
  assert.equal(completeness.checks.length, 3, "TIME_BOXED must not appear once PINNED already satisfied the slot");
  assert.ok(!completeness.checks.some((c) => c.id === "DEPENDENCY_BASIS_TIME_BOXED"));
});

test("neither basis held: both alternatives appear in the receipt, both unmet, still refused", () => {
  const completeness = computeCompleteness(
    "install",
    {
      DEPENDENCY_BASIS_PINNED: { satisfied: false, observed: "no lockfile and no packageManager field" },
      DEPENDENCY_BASIS_TIME_BOXED: { satisfied: false, observed: "no independently-sourced historical cutoff supplied" },
      COMMAND_RESOLVED: { satisfied: true, observed: "argv of 2 token(s)" },
      WORKING_DIRECTORY_KNOWN: { satisfied: true, observed: "repository root" },
    },
    [],
  );
  assert.equal(completeness.executable, false);
  assert.equal(completeness.checks.filter((c) => c.id.startsWith("DEPENDENCY_BASIS")).length, 2, "both must be visible, not hidden behind each other");
  assert.deepEqual(completeness.missing, [
    "a pinned dependency basis (lockfile or packageManager field)",
    "a defensible time-boxed dependency basis (no committed lock, resolution bounded to the repository's own historical CI run)",
  ]);
});

test("the second alternative alone satisfies the slot", () => {
  const completeness = computeCompleteness(
    "install",
    {
      DEPENDENCY_BASIS_PINNED: { satisfied: false, observed: "no lockfile and no packageManager field" },
      DEPENDENCY_BASIS_TIME_BOXED: { satisfied: true, observed: "install bounded to versions published on or before 2026-09-01T08:25:03Z (npm --before)" },
      COMMAND_RESOLVED: { satisfied: true, observed: "argv of 3 token(s)" },
      WORKING_DIRECTORY_KNOWN: { satisfied: true, observed: "repository root" },
    },
    [],
  );
  assert.equal(completeness.executable, true);
  assert.equal(completeness.checks.length, 4, "both PINNED and TIME_BOXED are shown when PINNED failed - transparency, not one hidden behind the other");
});

// ---------------------------------------------------------------------------------------------
// infer.ts integration — command construction and the remaining negative cases
// ---------------------------------------------------------------------------------------------

function installOp(pipeline: ReturnType<typeof inferPipeline>) {
  const op = pipeline.operations.find((o) => o.kind === "install");
  assert.ok(op, "expected an install operation to be inferred");
  return op!;
}

test("negative case 1 (integration): no cutoff supplied — behavior unchanged from before this feature existed", () => {
  const facts: ObservedFact[] = [RUN_STEP("npm install")];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW /* no cutoff */);
  const op = installOp(pipeline);
  assert.deepEqual(op.command, ["npm", "install"], "no cutoff means no mutation, exactly as before");
  assert.equal(op.executable, false);
});

test("a genuine npm install with a supplied cutoff gets --before=<cutoff> appended, and becomes executable", () => {
  const facts: ObservedFact[] = [RUN_STEP("npm install")];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW, CUTOFF);
  const op = installOp(pipeline);
  assert.deepEqual(op.command, ["npm", "install", `--before=${CUTOFF}`]);
  assert.equal(op.executable, true);
  const timeBoxed = op.requirementChecks?.find((c) => c.id === "DEPENDENCY_BASIS_TIME_BOXED");
  assert.equal(timeBoxed?.satisfied, true);
});

test("negative case 5 (integration): a yarn install with a supplied cutoff is NOT time-boxed — npm only, this phase", () => {
  const facts: ObservedFact[] = [RUN_STEP("yarn install")];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW, CUTOFF);
  const op = installOp(pipeline);
  assert.deepEqual(op.command, ["yarn", "install"], "the flag must never be appended to a non-npm command");
  assert.equal(op.executable, false, "a cutoff must not silently extend coverage to yarn");
});

test("a genuinely pinned repository (committed lockfile) never gets --before appended, even with a cutoff supplied", () => {
  const facts: ObservedFact[] = [RUN_STEP("npm install"), fact({ kind: "lockfile.present", value: "package-lock.json" })];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW, CUTOFF);
  const op = installOp(pipeline);
  assert.deepEqual(op.command, ["npm", "install"], "a pinned repository's command must be byte-for-byte unchanged");
  assert.equal(op.executable, true);
  assert.equal(op.requirementChecks?.some((c) => c.id === "DEPENDENCY_BASIS_TIME_BOXED"), false, "TIME_BOXED must not appear in a pinned repository's receipt");
});
