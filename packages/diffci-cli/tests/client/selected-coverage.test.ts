import assert from "node:assert/strict";
import { test } from "node:test";
import { batchCommand } from "../../src/client/command-batches.js";
import { commandArguments, runnerTestCount, unmatchedNodeTests } from "../../src/client/selected-coverage.js";
import { executableSelection } from "../../src/client/verify.js";
import type { ObservationReport } from "../../src/client/report.js";

// DentalPresence ebac4289f73a, CLI 0.3.21: the selected route test was handed to node --test as a glob
// that matches nothing, the other selected files passed, and verify reported passed.
const nextPaths = ["src/app/[id]/page.test.ts", "src/app/ingest/[...path]/route.test.ts", "src/app/docs/[[...slug]]/route.test.ts"];
const escaped = ['"src/app/[[]id[]]/page.test.ts"', '"src/app/ingest/[[]...path[]]/route.test.ts"', '"src/app/docs/[[][[]...slug[]][]]/route.test.ts"'];

type Result = NonNullable<ObservationReport["result"]>;
const result = (fields: Partial<Result>) => ({
  mode: "SELECTIVE", selectedTests: ["src/a.test.js"], totalTestCount: 10, fallbackReasons: [],
  proposedCommands: ["node --test src/a.test.js"], ...fields,
}) as Result;

test("reads the arguments sh or cmd.exe would pass, for the quoting DiffCI emits", () => {
  assert.deepEqual(commandArguments('node --test "src/app/[[]id[]]/x.test.ts" a\\ b.ts', false), ["node", "--test", "src/app/[[]id[]]/x.test.ts", "a b.ts"]);
  assert.deepEqual(commandArguments("node --test src/app/\\[id\\]/x.test.ts", false), ["node", "--test", "src/app/[id]/x.test.ts"]);
  assert.deepEqual(commandArguments("node --test src/app/\\[id\\]/x.test.ts", true), ["node", "--test", "src/app/\\[id\\]/x.test.ts"]);
});

test("finds the selected files node --test would not match, as 0.3.21 emitted them", () => {
  const legacy = "npx --no-install tsx --conditions react-server --test src/a.test.ts src/app/ingest/\\[...path\\]/route.test.ts";
  assert.deepEqual(unmatchedNodeTests(legacy, ["src/a.test.ts", "src/app/ingest/[...path]/route.test.ts"]), ["src/app/ingest/[...path]/route.test.ts"]);
  assert.deepEqual(unmatchedNodeTests(`node --test src/a.test.ts ${escaped.join(" ")}`, ["src/a.test.ts", ...nextPaths]), []);
  assert.deepEqual(unmatchedNodeTests("pnpm exec vitest run src/app/[id]/page.test.ts", ["src/app/[id]/page.test.ts"]), []);
});

test("broadens to the full suite instead of running a selection that skips a selected file", () => {
  const plan = executableSelection("/repo", result({
    selectedTests: ["src/a.test.js", "src/app/ingest/[...path]/route.test.js"],
    proposedCommands: ["node --test src/a.test.js src/app/ingest/\\[...path\\]/route.test.js"],
  }));
  assert.equal(plan.selection, "full");
  assert.match(plan.reason, /node --test would not match 1 selected test file\(s\), such as src\/app\/ingest\/\[\.\.\.path\]\/route\.test\.js/);

  const selected = executableSelection("/repo", result({
    selectedTests: ["src/a.test.js", "src/app/ingest/[...path]/route.test.js"],
    proposedCommands: ['node --test src/a.test.js "src/app/ingest/[[]...path[]]/route.test.js"'],
  }));
  assert.equal(selected.selection, "selected");
});

test("splits an over-long selection with escaped bracket paths", () => {
  const command = `node --test ${escaped.join(" ")}`;
  const batches = batchCommand(command, nextPaths, 60);
  assert.deepEqual(batches, escaped.map((arg) => `node --test ${arg}`));
});

test("reads the runner's own test count from its summary", () => {
  assert.equal(runnerTestCount("✔ a\nℹ tests 120\nℹ suites 3\nℹ pass 120\n"), 120);
  assert.equal(runnerTestCount("TAP version 13\n# tests 0\n# pass 0\n"), 0);
  assert.equal(runnerTestCount(" Test Files  3 passed (3)\n      Tests  17 passed (17)\n"), 3);
  assert.equal(runnerTestCount("Test Suites: 1 failed, 4 passed, 5 total\nTests:       9 passed, 9 total\n"), 5);
  assert.equal(runnerTestCount("ok\n"), undefined);
});
