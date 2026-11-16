// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runGenericPathBaseline } from "../../../src/research/baseline/path-baseline.js";
import type { ChangedFile } from "../../../src/git/types.js";
import { createTaskRegistry } from "../../../src/planner/task-registry.js";
import { LOCKFILE_NAMES } from "../../../src/repo/lockfiles.js";

describe("runGenericPathBaseline", () => {
  const registry = createTaskRegistry([
    { id: "unit", command: "npm test", category: "test", inputPatterns: ["src/**"] },
    { id: "lint", command: "npm run lint", category: "lint", alwaysRun: true },
  ]);

  function changed(...paths: string[]): ChangedFile[] {
    return paths.map((p) => ({ path: p, changeType: "modified" }));
  }

  const FULL_FALLBACK = "global/dependency/config/workflow -> full fallback";

  for (const name of LOCKFILE_NAMES) {
    it(`falls back to every task when only ${name} changes (issue #97)`, () => {
      const result = runGenericPathBaseline(registry, changed(name));
      assert.deepEqual(result.selectedTaskIds.sort(), ["lint", "unit"]);
      assert.ok(result.fallbackRequired);
      assert.deepEqual(result.matchedRules, [FULL_FALLBACK]);
    });
  }

  it("still falls back on the non-lockfile manifests", () => {
    for (const name of ["package.json", "go.sum", "Cargo.lock", "pyproject.toml"]) {
      const result = runGenericPathBaseline(registry, changed(name));
      assert.ok(result.fallbackRequired, name);
      assert.deepEqual(result.matchedRules, [FULL_FALLBACK], name);
    }
  });

  it("does not treat a nested lockfile as a root dependency change", () => {
    const result = runGenericPathBaseline(registry, changed("src/fixtures/package-lock.json"));
    assert.ok(!result.fallbackRequired);
    assert.deepEqual(result.selectedTaskIds.sort(), ["lint", "unit"]);
    assert.ok(!result.matchedRules.includes(FULL_FALLBACK));
  });
});
