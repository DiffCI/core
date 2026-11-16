// SPDX-License-Identifier: MIT
/**
 * Issue #126: a root `vitest.config.ts` that turns test isolation off gets no selected command.
 *
 * Without isolation, test files share state, so running only some of them is not safe. The workspace
 * version is covered in tests/repo/workspaces.test.ts; these cases cover a single root config, so the
 * detection (`runtimeIsolationUnsafe` in src/repo/test-discovery.ts) and the refusal in
 * src/planner/test-command.ts cannot break unnoticed.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import { analyzeRepository } from "../../src/repo/analyzer.js";

const REFUSAL = "Non-isolated or ambiguous Vitest isolation requires full validation";
const SELECTED = "src/value.test.ts";

function planWithConfig(testOptions: string) {
  const dir = mkdtempSync(join(tmpdir(), "diffci-vitest-isolation-"));
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  try {
    write("package.json", JSON.stringify({ name: "fixture", scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
    write("package-lock.json", "{}");
    write("vitest.config.ts", `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: ${testOptions} });\n`);
    write("src/value.ts", "export const value = 1;\n");
    write(SELECTED, "import { expect, test } from 'vitest';\nimport { value } from './value';\ntest('value', () => expect(value).toBe(1));\n");
    return planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), [SELECTED]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a root vitest.config.ts and test isolation (issue #126)", () => {
  for (const [name, options] of [
    ["isolate: false", "{ isolate: false }"],
    ["poolOptions.threads.isolate: false", "{ poolOptions: { threads: { isolate: false } } }"],
    ["an isolate value that is not the literal true", "{ isolate: process.env.CI !== undefined }"],
  ] as const) {
    it(`refuses to narrow with ${name}`, () => {
      const plan = planWithConfig(options);
      assert.deepEqual(plan.commands, []);
      assert.equal(plan.refusalReason, REFUSAL);
      assert.deepEqual(plan.unroutedPaths, [SELECTED]);
    });
  }

  it("emits a command with isolate: true", () => {
    const plan = planWithConfig("{ isolate: true }");
    assert.equal(plan.refusalReason, undefined);
    assert.ok(plan.commands.length > 0);
    assert.ok(plan.commands.some((command) => command.args.includes(SELECTED)), JSON.stringify(plan.commands));
  });
});
