// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import { declaredWorkspaceRoots } from "../../src/repo/workspaces.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "diffci-workspaces-"));
  const write = (path: string, content: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); };
  write("package.json", JSON.stringify({ scripts: { test: "pnpm -r run test" } }));
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - '!packages/excluded'\n");
  for (const name of ["a", "b", "excluded"]) {
    write(`packages/${name}/package.json`, JSON.stringify({ scripts: { test: name === "a" ? "vitest --typecheck" : "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
    write(`packages/${name}/vitest.config.ts`, "export default {test:{include:['src/**/*.test.ts']}};");
    write(`packages/${name}/src/value.test.ts`, "import {test} from 'vitest'; test('value',()=>{});");
  }
  return { dir, write };
}

it("routes identical test filenames through their declared package configs and retains all type checks", () => {
  const { dir } = fixture();
  try {
    assert.deepEqual(declaredWorkspaceRoots(dir), ["packages/a", "packages/b"]);
    const profile = analyzeRepository({ repoPath: dir });
    assert.equal(profile.workspaceTestPackages?.length, 2);
    const plan = planSelectiveTestCommands(profile, ["packages/a/src/value.test.ts"]);
    assert.equal(plan.refusalReason, undefined);
    assert.deepEqual(plan.commands.map(c => c.args), [
      ["--dir", "packages/a", "exec", "vitest", "run", "--config", "vitest.config.ts", "src/value.test.ts"],
      ["--dir", "packages/a", "exec", "vitest", "run", "--typecheck.only", "--passWithNoTests"],
    ]);
    assert.ok(planSelectiveTestCommands(profile, ["packages/excluded/src/value.test.ts"]).refusalReason);
    assert.ok(planSelectiveTestCommands(profile, ["packages/a/src/unknown.test.ts"]).refusalReason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("refuses workspace scripts whose extra validation or lifecycle work cannot be retained", () => {
  const { dir, write } = fixture();
  try {
    for (const scripts of [{ test: "vitest --coverage" }, { test: "vitest run", pretest: "node setup.js" }, { test: "lint && vitest run" }]) {
      write("packages/b/package.json", JSON.stringify({ scripts, devDependencies: { vitest: "4.1.8" } }));
      const plan = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["packages/a/src/value.test.ts"]);
      assert.ok(plan.refusalReason);
      assert.equal(plan.commands.length, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("batches long selections without dropping or duplicating test identities", () => {
  const { dir } = fixture();
  try {
    const profile = analyzeRepository({ repoPath: dir });
    const suite = profile.workspaceTestPackages![0]!;
    suite.profile.testFilePaths = Array.from({ length: 300 }, (_, i) => `src/${'nested/'.repeat(6)}value-${i}.test.ts`);
    const selected = suite.profile.testFilePaths.map(path => `${suite.packageRoot}/${path}`);
    const plan = planSelectiveTestCommands(profile, selected);
    assert.equal(plan.refusalReason, undefined);
    assert.ok(plan.commands.length > 3);
    assert.deepEqual(plan.groups.flatMap(group => group.paths).sort(), [...selected].sort());
    assert.ok(plan.commands.every(command => command.args.join(' ').length < 5000));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
