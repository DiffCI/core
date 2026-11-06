import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeTestFileResults, parseTestFileResults } from "../../src/client/test-results.js";

test("reads vitest file lines, with and without failures, units and project labels", () => {
  const output = [
    " ✓ src/a.test.ts (3 tests) 12ms",
    " ❯ src/b.test.ts (4 tests | 1 failed) 1.25s",
    "   × fails on empty input 3ms",
    " × src/c.test.ts (2 tests | 2 failed) 7ms",
    " ✓ |web| src/d.test.tsx (1 test | 1 skipped)",
    "\x1b[32m ✓\x1b[39m src/e.test.ts \x1b[2m(1 test)\x1b[22m\x1b[2m 4ms\x1b[22m",
    " Test Files  2 failed | 3 passed (5)",
  ].join("\n");
  assert.deepEqual(parseTestFileResults(output), [
    { file: "src/a.test.ts", status: "passed", ms: 12 },
    { file: "src/b.test.ts", status: "failed", ms: 1250 },
    { file: "src/c.test.ts", status: "failed", ms: 7 },
    { file: "src/d.test.tsx", status: "passed" },
    { file: "src/e.test.ts", status: "passed", ms: 4 },
  ]);
});

test("reads jest PASS and FAIL lines, with a duration only when jest prints one", () => {
  const output = [
    "PASS src/a.test.js",
    "FAIL src/b.test.ts (5.123 s)",
    "PASS web src/c.test.tsx (1.5 s)",
    "  ● b › rejects bad input",
    "Test Suites: 1 failed, 2 passed, 3 total",
  ].join("\r\n");
  assert.deepEqual(parseTestFileResults(output), [
    { file: "src/a.test.js", status: "passed" },
    { file: "src/b.test.ts", status: "failed", ms: 5123 },
    { file: "src/c.test.tsx", status: "passed", ms: 1500 },
  ]);
});

test("yields nothing for output it does not recognise", () => {
  assert.deepEqual(parseTestFileResults("ℹ tests 3\nℹ pass 3\n✔ adds numbers (1.2ms)"), []);
});

test("merges results so a later run of a file replaces an earlier one", () => {
  assert.deepEqual(
    mergeTestFileResults([{ file: "b", status: "failed", ms: 2 }, { file: "a", status: "passed" }], undefined, [{ file: "b", status: "passed", ms: 3 }]),
    [{ file: "a", status: "passed" }, { file: "b", status: "passed", ms: 3 }],
  );
});
