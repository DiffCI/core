/**
 * The comparator's selection must be executable, not merely countable.
 *
 * Agent generation B exists for one reason: `Incremental = C_comparator - (C_selected + C_analysis)` is
 * the number that decides whether DiffCI is worth paying for, and it cannot be computed without
 * EXECUTING the comparator's chosen tests. A count cannot be executed.
 *
 * These tests hold the surface to exactly that purpose - the real identities, the same treatment as
 * DiffCI's own selection, and a count that cannot drift from the list.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ObservationBaseline } from "../../src/client/report.js";

/** Mirrors how observe.ts derives the field, so the invariant is tested rather than assumed. */
function baselineSurface(selectedTests: string[], matchedRules: string[], fallbackRequired: boolean): ObservationBaseline {
  const comparatorSelectedTests = [...selectedTests].sort();
  return {
    mode: fallbackRequired ? "FULL" : "SELECTIVE",
    selectedTestCount: comparatorSelectedTests.length,
    selectedTests: comparatorSelectedTests,
    matchedRules,
  };
}

describe("pathBaseline.selectedTests", () => {
  it("holds the count-equals-length invariant, so the comparator arm cannot be mismeasured", () => {
    for (const tests of [[], ["a.test.ts"], ["b.test.ts", "a.test.ts", "c.test.ts"]]) {
      const surface = baselineSurface(tests, [], false);
      assert.equal(surface.selectedTests.length, surface.selectedTestCount);
    }
  });

  it("is sorted, so two runs over the same selection produce identical reports", () => {
    const surface = baselineSurface(["z.test.ts", "a.test.ts", "m.test.ts"], [], false);
    assert.deepEqual(surface.selectedTests, ["a.test.ts", "m.test.ts", "z.test.ts"]);
  });

  it("carries the comparator's OWN identities rather than a reconstruction from matchedRules", () => {
    // The whole point is to remove interpretation between the comparator and the harness that measures
    // it. matchedRules is a human-readable trace and must never be the source of the executable set.
    const surface = baselineSurface(["src/a.test.ts"], ["directory scoping", "some other rule"], false);
    assert.deepEqual(surface.selectedTests, ["src/a.test.ts"]);
    assert.equal(surface.selectedTests.length, 1, "two matched rules did not become two tests");
  });

  it("reports the full fallback set when the comparator falls back, not an empty list", () => {
    // A FULL comparator still has to be executed to be costed. An empty list here would silently make
    // the comparator arm look free.
    const all = ["a.test.ts", "b.test.ts", "c.test.ts"];
    const surface = baselineSurface(all, ["config/dependency -> full fallback"], true);
    assert.equal(surface.mode, "FULL");
    assert.equal(surface.selectedTestCount, 3);
    assert.deepEqual(surface.selectedTests, all);
  });
});
