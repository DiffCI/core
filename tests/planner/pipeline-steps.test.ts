// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { discoverGateChecks, workflowGateScripts } from "../../src/planner/pipeline-steps.js";

const ids = (scripts: Record<string, string>, options = {}) => discoverGateChecks(scripts, options).checks.map((c) => c.id);

describe("discoverGateChecks", () => {
  it("expands a dogfood-style check script into its leaves", () => {
    const scripts = {
      check: "npm run typecheck && npm run lint && node scripts/run-parallel.mjs check:unused check:routes",
      typecheck: "tsc --noEmit",
      lint: "eslint src",
      "check:unused": "node scripts/check-unused.mjs",
      "check:routes": "node scripts/check-routes.mjs",
      test: "vitest run",
    };
    const gate = discoverGateChecks(scripts);
    assert.deepEqual(gate.roots, ["check"]);
    assert.deepEqual(gate.checks.map((c) => [c.id, c.kind, c.runsScript]), [
      ["typecheck", "typecheck", true],
      ["lint", "lint", true],
      ["check:unused", "script", true],
      ["check:routes", "script", true],
    ]);
    assert.ok(gate.checks.every((c) => c.decision === "RUN" && /not yet narrowed/.test(c.reason)));
  });

  it("splits inline parts of a script and keeps their text", () => {
    const gate = discoverGateChecks({ check: "tsc --noEmit && eslint . ; node scripts/arch.js" });
    assert.deepEqual(gate.checks.map((c) => [c.id, c.command, c.runsScript]), [
      ["check[1]", "tsc --noEmit", false],
      ["check[2]", "eslint .", false],
      ["check[3]", "node scripts/arch.js", false],
    ]);
  });

  it("keeps a script whole when splitting would change its meaning", () => {
    for (const body of ["tsc || true", "eslint . | tee out.txt", "NODE_ENV=ci eslint .", "tsc && eslint \"$DIR\"", "tsc & eslint ."]) {
      assert.deepEqual(discoverGateChecks({ check: body }).checks.map((c) => [c.id, c.runsScript]), [["check", true]], body);
    }
  });

  it("leaves test runs to test selection but keeps mixed bodies", () => {
    const gate = discoverGateChecks({ check: "npm run lint && npm test", lint: "eslint .", test: "vitest run" });
    assert.deepEqual(gate.checks.map((c) => c.id), ["lint"]);
    assert.deepEqual(gate.coveredByTests, ["test"]);
    assert.deepEqual(ids({ check: "tsc && vitest run | tee log" }), ["check"]);
  });

  it("follows run-all globs and concurrently", () => {
    assert.deepEqual(ids({ check: "run-p -l check:*", "check:a": "node a.js", "check:b": "node b.js", other: "x" }), ["check:a", "check:b"]);
    assert.deepEqual(ids({ check: "concurrently \"npm:lint\" \"tsc --noEmit\"", lint: "eslint ." }), ["lint", "check[1.2]"]);
  });

  it("runs lifecycle hooks only when the package manager does", () => {
    const scripts = { check: "tsc && eslint .", precheck: "node gen.js", postcheck: "node after.js" };
    assert.deepEqual(ids(scripts), ["precheck", "check[1]", "check[2]", "postcheck"]);
    assert.deepEqual(ids(scripts, { lifecycleHooks: false }), ["check[1]", "check[2]"]);
  });

  it("adds check-named scripts that CI workflows run, never deploys", () => {
    const scripts = { check: "tsc", "validate:release": "node scripts/check-architecture-boundaries.js && node scripts/release.mjs", "deploy:staging": "wrangler deploy", lint: "eslint ." };
    const workflow = [
      "jobs:",
      "  gate:",
      "    steps:",
      "      - run: npm ci",
      "      - run: npm run check",
      "      - run: npm run validate:release",
      "      - run: npm run deploy:staging",
      "  retired:",
      "    if: false",
      "    steps:",
      "      - run: npm run lint",
    ].join("\n");
    const workflowScripts = workflowGateScripts([workflow, "not: [valid"], scripts);
    assert.deepEqual(workflowScripts, ["check", "validate:release"]);
    const gate = discoverGateChecks(scripts, { workflowScripts });
    assert.deepEqual(gate.roots, ["check", "validate:release"]);
    assert.deepEqual(gate.checks.map((c) => c.id), ["check", "validate:release[1]", "validate:release[2]"]);
    assert.match(gate.checks[1]!.reason, /part of validate:release/);
    assert.match(discoverGateChecks({ check: "tsc", "lint:css": "stylelint ." }, { workflowScripts: ["lint:css"] }).checks[1]!.reason, /run by a CI workflow/);
  });

  it("uses conventional scripts when there is no check script, and survives cycles", () => {
    assert.deepEqual(discoverGateChecks({ lint: "eslint .", typecheck: "tsc", build: "vite build" }).roots, ["typecheck", "lint"]);
    assert.deepEqual(discoverGateChecks({ test: "vitest" }).checks, []);
    assert.deepEqual(ids({ check: "npm run a && tsc", a: "npm run check && eslint ." }), ["check", "a[2]", "check[2]"]);
  });
});
