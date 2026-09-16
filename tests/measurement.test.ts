// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, estimateImpact } from "../src/measurement.js";

test("measure returns the result and labels current-process observations", async () => {
  const result = await measure(async () => 42);
  assert.equal(result.value, 42);
  assert.equal(result.measurement.scope, "current-process");
  assert.equal(result.measurement.basis, "measured");
  assert.ok(result.measurement.wallSeconds >= 0);
  assert.ok(result.measurement.cpuSeconds >= 0);
  assert.ok(result.measurement.rssBytesAtEnd > 0);
});

test("energy and carbon calculations use explicit units and remain estimates", () => {
  const result = estimateImpact({ computeSeconds: 3600, usdPerComputeSecond: 0.001, watts: 100, gridGramsCo2ePerKwh: 400 });
  assert.equal(result.estimatedKwh, 0.1);
  assert.equal(result.estimatedKgCo2e, 0.04);
  assert.equal(result.estimatedUsd, 3.6);
  assert.equal(result.basis, "estimated");
  for (const invalid of [-1, NaN, Infinity]) assert.throws(() => estimateImpact({ computeSeconds: invalid, usdPerComputeSecond: 0, watts: 0, gridGramsCo2ePerKwh: 0 }));
});
