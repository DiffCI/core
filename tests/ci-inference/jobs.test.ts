// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";

import { inferPipeline } from "../../src/ci-inference/infer.js";
import { planForPurpose } from "../../src/ci-inference/jobs.js";
import type { ObservedFact } from "../../src/ci-inference/schema.js";

const evidence = (text: string) => ({ file: ".github/workflows/ci.yml", text });
const job = { workflow: "ci.yml", job: "test" };

test("TEST is planned from the matrix instance that runs the test step, not one whose condition skips it", () => {
  const facts: ObservedFact[] = [
    { kind: "lockfile.present", value: "package-lock.json", evidence: { file: "package-lock.json", text: "package-lock.json" } },
    { kind: "workflow.matrix", value: JSON.stringify({ os: ["windows-latest", "ubuntu-latest"] }), evidence: evidence("matrix"), attributes: job },
    { kind: "workflow.step.run", value: "npm ci", evidence: evidence("npm ci"), attributes: { ...job, step: "0" } },
    { kind: "workflow.step.run", value: "npx jest", evidence: evidence("npx jest"), attributes: { ...job, step: "1", if: "matrix.os == 'ubuntu-latest'" } },
  ];
  const pipeline = inferPipeline("C:/__diffci-jobs-test-fixture-does-not-exist__", "test/repo", "abc123", facts, "2026-11-17T00:00:00.000Z");
  const plan = planForPurpose(pipeline.jobs, "TEST");
  assert.equal(plan.jobId, "ci.yml#test-osubuntu-latest");
  assert.equal(plan.executable, true, plan.refusal);
});

test("when every instance skips the test step, TEST is still refused", () => {
  const facts: ObservedFact[] = [
    { kind: "lockfile.present", value: "package-lock.json", evidence: { file: "package-lock.json", text: "package-lock.json" } },
    { kind: "workflow.step.run", value: "npm ci", evidence: evidence("npm ci"), attributes: { ...job, step: "0" } },
    { kind: "workflow.step.run", value: "npx jest", evidence: evidence("npx jest"), attributes: { ...job, step: "1", if: "false" } },
  ];
  const pipeline = inferPipeline("C:/__diffci-jobs-test-fixture-does-not-exist__", "test/repo", "abc123", facts, "2026-11-17T00:00:00.000Z");
  const plan = planForPurpose(pipeline.jobs, "TEST");
  assert.equal(plan.executable, false);
  assert.match(plan.refusal ?? "", /no executable operation in this path causally provides TEST/);
});
