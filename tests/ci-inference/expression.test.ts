// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateCondition } from "../../src/ci-inference/expression.js";
import { inferPipeline } from "../../src/ci-inference/infer.js";
import type { ObservedFact } from "../../src/ci-inference/schema.js";

// GitHub Actions: "GitHub ignores case when comparing strings."
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#operators
test("`==` and `!=` compare strings ignoring case, as GitHub does", () => {
  const context = { matrix: { os: "ubuntu-latest" } };
  assert.equal(evaluateCondition("matrix.os == 'Ubuntu-Latest'", context).result, "TRUE");
  assert.equal(evaluateCondition("${{ 'UBUNTU-LATEST' == matrix.os }}", context).result, "TRUE");
  assert.equal(evaluateCondition("matrix.os != 'Ubuntu-Latest'", context).result, "FALSE");
  assert.equal(evaluateCondition("matrix.os == 'windows-latest'", context).result, "FALSE");
  assert.equal(evaluateCondition("matrix.os != 'Windows-Latest'", context).result, "TRUE");
});

test("a step whose condition differs from the matrix value only in case still runs", () => {
  const facts: ObservedFact[] = [
    { kind: "workflow.matrix", value: JSON.stringify({ os: ["ubuntu-latest"] }), evidence: { file: ".github/workflows/ci.yml", text: "matrix" }, attributes: { workflow: "ci.yml", job: "test" } },
    { kind: "workflow.step.run", value: "npm test", evidence: { file: ".github/workflows/ci.yml", text: "npm test" }, attributes: { workflow: "ci.yml", job: "test", step: "0", if: "matrix.os == 'Ubuntu-Latest'" } },
  ];
  const pipeline = inferPipeline("C:/__diffci-expression-test-fixture-does-not-exist__", "test/repo", "abc123", facts, "2026-11-17T00:00:00.000Z");
  const operation = pipeline.operations.find((o) => o.condition !== undefined);
  assert.equal(operation?.condition?.result, "TRUE");
  assert.equal(operation?.willExecute, true);
});
