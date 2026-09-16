// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Defect 30 — evidence integrity, not wording.
 *
 * `"a resolved package manager"` was implemented as `command.length > 0`. The label said package
 * manager; the code tested whether the command was empty. webpack's refusal cited it against a
 * repository that pins `yarn@1.22.22` WITH a committed lockfile — so the receipt asserted evidence the
 * engine had never established, and a maintainer acting on it would have hunted a problem that did not
 * exist. That is what made the refusal INCORRECT rather than merely unhelpful.
 *
 * The structural fix: every requirement carries the predicate the code tests and what was observed, so
 * a label divorced from its implementation has nowhere to hide.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPLETENESS_REQUIREMENTS, REQUIREMENT_PREDICATES, computeCompleteness } from "../../src/ci-inference/reference-graph.js";

test("the mislabelled requirement is DELETED, not renamed into place", () => {
  const every = Object.values(COMPLETENESS_REQUIREMENTS).flat();
  assert.ok(!every.includes("PACKAGE_MANAGER_RESOLVED" as never), "it duplicated the command check while claiming something else");
  for (const spec of Object.values(REQUIREMENT_PREDICATES)) {
    assert.doesNotMatch(spec.label, /package manager/i, "no requirement may claim to resolve a package manager");
  }
});

test("every requirement states the predicate its code actually tests", () => {
  for (const [id, spec] of Object.entries(REQUIREMENT_PREDICATES)) {
    assert.ok(spec.predicate.length > 20, `${id} must state what is tested, not just name itself`);
    assert.notEqual(spec.predicate, spec.label, `${id}: a predicate restating the label carries no evidence`);
  }
});

test("a receipt reports what was OBSERVED, not merely pass/fail", () => {
  const completeness = computeCompleteness(
    "install",
    {
      DEPENDENCY_BASIS_PINNED: { satisfied: true, observed: "lockfile yarn.lock" },
      COMMAND_RESOLVED: { satisfied: true, observed: "argv of 2 token(s)" },
      WORKING_DIRECTORY_KNOWN: { satisfied: true, observed: "repository root" },
    },
    [],
  );

  assert.equal(completeness.executable, true);
  const basis = completeness.checks.find((c) => c.id === "DEPENDENCY_BASIS_PINNED")!;
  assert.equal(basis.observed, "lockfile yarn.lock", "the receipt must carry the evidence, not just the verdict");
  assert.match(basis.predicate, /lockfile or declares a packageManager/);
});

test("an unobserved requirement is NOT silently satisfied", () => {
  const completeness = computeCompleteness("install", {}, []);
  assert.equal(completeness.executable, false);
  for (const check of completeness.checks) {
    assert.equal(check.satisfied, false);
    assert.equal(check.observed, "not observed", "absence of an observation is not evidence of satisfaction");
  }
});

test("webpack's shape: a pinned repository is no longer told its package manager is unresolved", () => {
  // webpack pins packageManager yarn@1.22.22 AND commits yarn.lock.
  const completeness = computeCompleteness(
    "install",
    {
      DEPENDENCY_BASIS_PINNED: { satisfied: true, observed: "packageManager yarn@1.22.22" },
      COMMAND_RESOLVED: { satisfied: false, observed: "no argv could be built for this line" },
      WORKING_DIRECTORY_KNOWN: { satisfied: true, observed: "repository root" },
    },
    [],
  );

  assert.deepEqual(completeness.missing, ["a resolved command"], "the honest cause is the unbuildable argv, not the package manager");
});
