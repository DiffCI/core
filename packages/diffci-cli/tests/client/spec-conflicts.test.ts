import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { detectSpecificationConflicts } from "../../src/client/spec-conflicts.js";

describe("same-turn specification conflicts", () => {
  it("names every specification id that changes the same logical target", () => {
    const report = detectSpecificationConflicts([
      { id: "SPEC-API", logicalTarget: "com.example.Widget#run" },
      { id: "SPEC-BEHAVIOR", logicalTarget: "com.example.Widget#run" },
      { id: "SPEC-DOCS", logicalTarget: "README:usage" },
    ]);

    assert.equal(report.valid, false);
    assert.deepEqual(report.conflicts, [{
      logicalTarget: "com.example.Widget#run",
      specificationIds: ["SPEC-API", "SPEC-BEHAVIOR"],
    }]);
    assert.match(report.blockers[0]!, /SPEC-API, SPEC-BEHAVIOR/);
  });

  it("accepts distinct targets and supports one specification with several targets", () => {
    const report = detectSpecificationConflicts([
      { id: "SPEC-1", logicalTarget: ["api:Widget", "method:Widget.run"] },
      { id: "SPEC-2", logicalTarget: "method:Widget.stop" },
    ]);
    assert.equal(report.valid, true);
    assert.equal(report.logicalTargetsChecked, 3);
  });

  it("rejects duplicate ids instead of silently merging them", () => {
    assert.throws(() => detectSpecificationConflicts([
      { id: "SPEC-1", logicalTarget: "a" },
      { id: "SPEC-1", logicalTarget: "b" },
    ]), /duplicate specification id/);
  });
});

