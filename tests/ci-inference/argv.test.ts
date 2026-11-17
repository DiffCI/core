// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";

import { inferPipeline } from "../../src/ci-inference/infer.js";
import type { ObservedFact } from "../../src/ci-inference/schema.js";

/** The single operation inferred from one `run:` line. */
function operationFor(line: string) {
  const facts: ObservedFact[] = [
    { kind: "workflow.step.run", value: line, evidence: { file: ".github/workflows/ci.yml", text: line }, attributes: { workflow: "ci.yml", job: "test", step: "0" } },
  ];
  const pipeline = inferPipeline("C:/__diffci-argv-test-fixture-does-not-exist__", "test/repo", "abc123", facts, "2026-11-17T00:00:00.000Z");
  assert.equal(pipeline.operations.length, 1);
  return pipeline.operations[0]!;
}

// `command` is "argv, never a shell string, so it cannot be re-split differently later" (schema.ts): it must be what
// `sh` would pass to the program, or there must be none.
test("quotes are removed the way sh removes them", () => {
  assert.deepEqual(operationFor(`npx jest --testNamePattern "user login"`).command, ["npx", "jest", "--testNamePattern", "user login"]);
  assert.deepEqual(operationFor(`npx mocha --grep 'a b'`).command, ["npx", "mocha", "--grep", "a b"]);
  assert.deepEqual(operationFor(`npx vitest run --reporter="dot"`).command, ["npx", "vitest", "run", "--reporter=dot"]);
});

test("shell syntax the splitter does not reproduce leaves the test step without argv", () => {
  for (const line of [
    `npx jest --ci \\`, // continues onto the next run: line
    `npx jest --testNamePattern "user login`, // unbalanced quote
    `npx jest # every test`, // comment
    `npx jest src/*.test.js`, // sh expands the glob
    `npx jest ~/suite`, // sh expands ~
    `CI=true npx jest`, // environment assignment, not argv[0]
  ]) {
    const operation = operationFor(line);
    assert.equal(operation.kind, "test", line);
    assert.deepEqual(operation.command, [], line);
    assert.equal(operation.executable, false, line);
    assert.equal(operation.executionRepresentation, "UNRESOLVED", line);
  }
});

test("plain words are still split as before", () => {
  assert.deepEqual(operationFor("npx jest --ci --runInBand").command, ["npx", "jest", "--ci", "--runInBand"]);
});
