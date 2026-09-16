// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage 2C Part 4 - regression tests written BEFORE the production fix (src/research/baseline/test-
 * activity.ts), reproducing the exact Stage 2B failure mode: a job named "check" running a compound
 * `typecheck && test` command was invisible to the pre-existing name/step-only classifier.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectTestCommand, isTestRunnerCommand, resolveScriptCommands } from "../../../src/research/baseline/test-activity.js";

describe("isTestRunnerCommand", () => {
  it("recognizes common test-runner invocations", () => {
    for (const cmd of ["npm test", "npm run test", "npm run test:unit", "pnpm test", "pnpm vitest --coverage", "yarn test", "vitest", "jest", "node --test", "pytest", "go test ./...", "cargo test"]) {
      assert.equal(isTestRunnerCommand(cmd), true, `expected "${cmd}" to be recognized`);
    }
  });

  it("does not recognize non-test commands", () => {
    for (const cmd of ["npm run lint", "npm run build", "npm run typecheck", "eslint src/", "tsc --noEmit", "npm ci", "actions/checkout@v4"]) {
      assert.equal(isTestRunnerCommand(cmd), false, `expected "${cmd}" to NOT be recognized`);
    }
  });

  it("does not false-positive on substrings that merely contain a pattern's letters out of order or unrelated context", () => {
    // "contest" contains "test" as a substring but must not match \btest\b-anchored patterns used
    // elsewhere in this module's word-boundary regexes.
    assert.equal(isTestRunnerCommand("npm run contest-winner-announcer"), false);
  });
});

describe("resolveScriptCommands", () => {
  it("resolves an `npm run <script>` invocation to its real package.json definition", () => {
    const resolved = resolveScriptCommands("npm run check", { check: "npm run typecheck && npm run test" });
    assert.deepEqual(resolved, ["npm run typecheck && npm run test"]);
  });

  it("resolves pnpm/yarn forms too", () => {
    assert.deepEqual(resolveScriptCommands("pnpm check", { check: "vitest run" }), ["vitest run"]);
    assert.deepEqual(resolveScriptCommands("pnpm run check", { check: "vitest run" }), ["vitest run"]);
    assert.deepEqual(resolveScriptCommands("yarn check", { check: "vitest run" }), ["vitest run"]);
  });

  it("silently skips a script name not present in package.json (e.g. a global tool invocation)", () => {
    assert.deepEqual(resolveScriptCommands("npm run corepack-enable-thing", {}), []);
  });

  it("does not recurse beyond one level - a script whose OWN resolution needs further lookup is left as raw text for the caller's own isTestRunnerCommand scan", () => {
    // scripts.check itself contains "npm run test", which resolveScriptCommands returns verbatim
    // (not further resolved into scripts.test's own definition) - the caller (detectTestCommand)
    // still finds it because isTestRunnerCommand matches the TEXT "npm run test" directly, not
        // because of a second resolution pass.
    const resolved = resolveScriptCommands("npm run check", { check: "npm run test", test: "vitest run" });
    assert.deepEqual(resolved, ["npm run test"]);
  });
});

describe("detectTestCommand - the exact Stage 2B regression", () => {
  it("Case A: a job whose ONLY command is a direct test-runner invocation is detected", () => {
    assert.equal(detectTestCommand(["npm test"], {}), true);
  });

  it("Case B: a job that runs ONLY lint must NOT be classified as having test activity", () => {
    assert.equal(detectTestCommand(["npm run lint"], { lint: "eslint src/" }), false);
  });

  it("Case C (THE Stage 2B regression): a job named like DiffCI.com's own 'check' - `npm run check` where check resolves to `typecheck && test` - is detected via one-level script resolution", () => {
    const runLines = ["npm ci", "npm run check"];
    const scripts = { check: "npm run typecheck && npm run test", typecheck: "tsc --noEmit", test: "tsx --test tests/**/*.test.ts" };
    assert.equal(detectTestCommand(runLines, scripts), true, "the exact shape of DiffCI.com's own CI job that Stage 2B found invisible to the classifier");
  });

  it("Case D: an explicit `test` job's direct command is still detected (no regression vs. the pre-existing name-based path, which this module doesn't replace)", () => {
    assert.equal(detectTestCommand(["npm run test"], {}), true);
  });

  it("Case E: an unrecognizable/custom job name with a directly recognizable test command is detected without any naming signal at all", () => {
    assert.equal(detectTestCommand(["pytest -v"], {}), true);
  });

  it("a job that runs typecheck AND build but genuinely never touches a test runner is not detected", () => {
    const runLines = ["npm run typecheck", "npm run build"];
    assert.equal(detectTestCommand(runLines, { typecheck: "tsc --noEmit", build: "webpack" }), false);
  });

  it("multi-line `run:` blocks (YAML `run: |` style, real DentalPresence.in shape) are scanned as one string", () => {
    const runLines = ["npm ci --no-audit --no-fund\nnpm test\n"];
    assert.equal(detectTestCommand(runLines, {}), true);
  });

  it("reproduces unjs/defu's real CI shape - job id 'ci', no explicit name, running `pnpm vitest --coverage` - detected by direct command even though inferCategory's name-based path would fall through to 'validation'", () => {
    assert.equal(detectTestCommand(["pnpm install", "pnpm lint", "pnpm build", "pnpm test:types", "pnpm vitest --coverage"], {}), true);
  });
});
