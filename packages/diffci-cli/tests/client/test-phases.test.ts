import assert from "node:assert/strict";
import { test } from "node:test";
import { executableSelection, phaseCommand } from "../../src/client/verify.js";
import type { ObservationReport } from "../../src/client/report.js";

type Result = NonNullable<ObservationReport["result"]>;
const result = (fields: Partial<Result>) => ({
  mode: "SELECTIVE", selectedTests: ["src/a.test.js"], totalTestCount: 10, fallbackReasons: [],
  proposedCommands: ["node --test src/a.test.js"], ...fields,
}) as Result;

test("runs test-script phases after the selected test files", () => {
  const plan = executableSelection("/repo", result({ testPhases: ["node scripts/test-security.js", "tsx --import ./setup.mjs scripts/guard.ts"] }));
  assert.equal(plan.selection, "selected");
  assert.deepEqual(plan.commands, ["node --test src/a.test.js", "node scripts/test-security.js", "npx --no-install tsx --import ./setup.mjs scripts/guard.ts"]);
  assert.equal(plan.command, plan.commands.join(" && "));
  assert.match(plan.reason, /also ran 2 test-script phase\(s\)/);
});

test("a selection without phases and a full fallback are unchanged", () => {
  assert.deepEqual(executableSelection("/repo", result({})).commands, ["node --test src/a.test.js"]);
  const full = executableSelection("/repo", result({ mode: "FULL", testPhases: ["node scripts/test-security.js"], fallbackReasons: ["x"] }));
  assert.equal(full.selection, "full");
  assert.ok(!full.commands.includes("node scripts/test-security.js"));
});

test("phase commands reach repository-local runners", () => {
  assert.equal(phaseCommand("node scripts/a.js"), "node scripts/a.js");
  assert.equal(phaseCommand("tsx scripts/a.ts"), "npx --no-install tsx scripts/a.ts");
});
