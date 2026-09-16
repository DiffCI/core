// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The distinction the causal graph exists to make:
 *
 *   "TEST exists, but its causal prerequisites are not established"   ≠   "TEST does not exist"
 *
 * The sample produced both and the engine could express neither. jest's real test command lives inside a
 * third-party action's inputs; babel's suite consumes an artifact built by another job. In both the
 * honest statement is that the outcome is present and its causes are not — and in both the engine
 * instead planned something else with confidence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { causalPathFor, type DeclaredPrerequisite } from "../../src/ci-inference/causal.js";
import type { InferredOperation } from "../../src/ci-inference/schema.js";

function op(partial: Partial<InferredOperation> & { id: string; kind: InferredOperation["kind"] }): InferredOperation {
  return {
    command: ["some", "command"],
    workingDirectory: ".",
    environment: {},
    dependsOn: [],
    evidence: [],
    confidence: "high",
    unresolved: [],
    executable: true,
    missingRequirements: [],
    blockedBy: [],
    willExecute: true,
    executionRepresentation: "RESOLVED",
    ...partial,
  } as InferredOperation;
}

test("no TEST operation at all is reported as ABSENT, not as incomplete", () => {
  const path = causalPathFor([op({ id: "install-0", kind: "install" })], "test");
  assert.equal(path.outcomePresent, false);
  assert.equal(path.complete, false);
  assert.match(path.reason, /no operation in this job provides test/);
});

test("TEST present with unrepresentable command is PRESENT but INCOMPLETE — webpack's shape", () => {
  const path = causalPathFor(
    [
      op({ id: "install-0", kind: "install" }),
      op({ id: "test-1", kind: "test", executionRepresentation: "UNRESOLVED", executable: false, command: [] }),
    ],
    "test",
  );

  assert.equal(path.outcomePresent, true, "the repository says this job tests — that fact survives");
  assert.equal(path.complete, false, "but we cannot run it");
  assert.match(path.reason, /test EXISTS but/);
  assert.match(path.reason, /cannot be represented for execution/);
});

test("an artifact produced by another job is an UNRESOLVED cause — babel's shape", () => {
  const prereqs: DeclaredPrerequisite[] = [
    { kind: "ARTIFACT", identifier: "babel-artifact", reason: "produced by a job this engine does not follow" },
  ];
  const path = causalPathFor([op({ id: "install-0", kind: "install" }), op({ id: "test-1", kind: "test" })], "test", prereqs);

  assert.equal(path.outcomePresent, true);
  assert.equal(path.complete, false);
  assert.equal(path.unresolved.length, 1);
  assert.equal(path.unresolved[0]!.relation, "CONSUMES_ARTIFACT");
});

test("a command inside a third-party action is an UNRESOLVED cause — jest's shape", () => {
  const prereqs: DeclaredPrerequisite[] = [
    { kind: "ACTION_EXECUTION", identifier: "nick-fields/retry@ad98453", reason: "the command is an input to an action this engine does not read" },
  ];
  const path = causalPathFor([op({ id: "test-1", kind: "test" })], "test", prereqs);

  assert.equal(path.outcomePresent, true);
  assert.equal(path.complete, false);
  assert.equal(path.unresolved[0]!.relation, "EXECUTES");
});

test("an unexecutable INSTALL blocks TEST — a suite on an uninstalled tree is a different outcome", () => {
  const path = causalPathFor(
    [op({ id: "install-0", kind: "install", executable: false, missingRequirements: ["a pinned dependency basis"] }), op({ id: "test-1", kind: "test" })],
    "test",
  );

  assert.equal(path.complete, false);
  assert.equal(path.unresolved[0]!.relation, "PROVIDES_DEPENDENCIES");
  assert.match(path.unresolved[0]!.reason!, /pinned dependency basis/);
});

test("a FALSE condition resolves the path rather than blocking it — the pipeline simply does not run it", () => {
  const path = causalPathFor(
    [op({ id: "install-0", kind: "install" }), op({ id: "skip-1", kind: "build", willExecute: false, executable: false }), op({ id: "test-2", kind: "test" })],
    "test",
  );

  assert.equal(path.complete, true, "a skipped step is a resolved fact about the path, not a hole in it");
});

test("an UNRESOLVED condition blocks — defect 29 preserved through the causal layer", () => {
  const path = causalPathFor(
    [op({ id: "install-0", kind: "install", willExecute: undefined, executable: false }), op({ id: "test-1", kind: "test" })],
    "test",
  );

  assert.equal(path.complete, false);
  assert.match(path.unresolved[0]!.reason!, /could not be evaluated/);
});

test("a job with no install is not missing one — the requirement is not invented", () => {
  const path = causalPathFor([op({ id: "test-1", kind: "test" })], "test");
  assert.equal(path.complete, true, "a repository that needs no install must not be refused for lacking one");
});

test("a fully established path is complete and says so", () => {
  const path = causalPathFor(
    [op({ id: "install-0", kind: "install" }), op({ id: "build-1", kind: "build" }), op({ id: "test-2", kind: "test" })],
    "test",
  );

  assert.equal(path.complete, true);
  assert.equal(path.unresolved.length, 0);
  assert.equal(path.edges.filter((e) => e.relation === "PROVIDES_BUILT_STATE").length, 1);
  assert.match(path.reason, /every required cause is established/);
});
