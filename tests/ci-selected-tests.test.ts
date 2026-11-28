import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
// @ts-expect-error plain ESM script without type declarations
import { decide } from "../scripts/ci-selected-tests.mjs";

const always = () => true;
const tests = (files: unknown) => JSON.stringify(files);

describe("Core CI selected tests", () => {
  it("runs everything without a plan, on any fallback, and on a bad list", () => {
    assert.deepEqual(decide({}, always), { mode: "full", reason: "no DiffCI plan for this run" });
    assert.equal(decide({ DIFFCI_FULL: "true", DIFFCI_REASON: "CI configuration changed" }, always).reason, "CI configuration changed");
    assert.equal(decide({ DIFFCI_FULL: "False", DIFFCI_TESTS: tests([]) }, always).mode, "full");
    // impact.mjs leaves the list empty, not "[]", when it is too large or redacted.
    assert.equal(decide({ DIFFCI_FULL: "false", DIFFCI_TESTS: "" }, always).mode, "full");
    assert.equal(decide({ DIFFCI_FULL: "false", DIFFCI_TESTS: "{}" }, always).mode, "full");
    assert.equal(decide({ DIFFCI_FULL: "false", DIFFCI_TESTS: tests([1]) }, always).mode, "full");
  });

  it("runs everything when a selected path is unexpected or missing", () => {
    for (const file of ["src/analyze.ts", "tests/../src/x.test.ts", "/tests/a.test.ts", "tests\\a.test.ts", "tests/a.test.js"]) {
      assert.equal(decide({ DIFFCI_FULL: "false", DIFFCI_TESTS: tests([file]) }, always).mode, "full", file);
    }
    assert.equal(decide({ DIFFCI_FULL: "false", DIFFCI_TESTS: tests(["tests/gone.test.ts"]) }, () => false).mode, "full");
  });

  it("narrows to root test files and leaves CLI package tests to their own job", () => {
    const decision = decide(
      { DIFFCI_FULL: "false", DIFFCI_TESTS: tests(["tests/analyze.test.ts", "tests/repo/x.test.ts", "packages/diffci-cli/tests/y.test.ts"]) },
      always,
    );
    assert.deepEqual(decision, {
      mode: "selected",
      files: ["tests/analyze.test.ts", "tests/repo/x.test.ts"],
      skipped: ["packages/diffci-cli/tests/y.test.ts"],
    });
    assert.deepEqual(decide({ DIFFCI_FULL: "false", DIFFCI_TESTS: "[]" }, always), { mode: "selected", files: [], skipped: [] });
  });

  it("keeps the full suite glob in step with npm test", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const script = readFileSync(new URL("../scripts/ci-selected-tests.mjs", import.meta.url), "utf8");
    assert.equal(pkg.scripts.test, 'tsx --test "tests/**/*.test.ts"');
    assert.match(script, /args = \['tests\/\*\*\/\*\.test\.ts'\]/);
  });

  it("is wired into Core CI with a nightly full run", () => {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    assert.match(ci, /run: node scripts\/ci-selected-tests\.mjs/);
    assert.match(ci, /schedule:\n\s+- cron:/);
    assert.doesNotMatch(ci, /^\s+- run: npm test$/m);
  });
});
