import { strict as assert } from "node:assert";
import { it } from "node:test";
import { formatGrowthPrompt, type VerifySavingsReport } from "../../src/client/verify-savings.js";

it("invites stars only when valid runtime evidence shows a positive reduction", () => {
  const report = (evidenceValid: boolean, percentChange: number) => ({ comparison: { evidenceValid, percentChange } } as VerifySavingsReport);
  assert.match(formatGrowthPrompt(report(true, 12)), /https:\/\/github.com\/DiffCI\/core/);
  for (const value of [report(false, 12), report(true, 0), report(true, -5), report(true, NaN)]) {
    assert.equal(formatGrowthPrompt(value), "");
  }
});
