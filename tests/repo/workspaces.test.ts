// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import { declaredWorkspaceRoots } from "../../src/repo/workspaces.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";

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

it("uses each package's aliases and follows newly resolved implementations", async () => {
  const { dir, write } = fixture();
  try {
    for (const name of ["a", "b"]) {
      write(`packages/${name}/tsconfig.json`, JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", module: "ESNext", paths: { alias: ["./src/value.ts"] } }, include: ["src/**/*.ts"] }));
      write(`packages/${name}/src/value.test.ts`, "import {value} from 'alias'; console.log(value);");
      write(`packages/${name}/src/value.ts`, "import {nested} from './nested'; export const value=nested;");
      write(`packages/${name}/src/nested.ts`, "export const nested=1;");
    }
    const result = await buildDependencyGraph({ repoPath: dir });
    assert.equal(result.unresolved.length, 0);
    for (const name of ["a", "b"]) assert.deepEqual(result.graph.dependenciesOf(`packages/${name}/src/value.test.ts`), [`packages/${name}/src/value.ts`]);
    write("packages/a/tsconfig.json", "{ broken");
    const invalid = await buildDependencyGraph({ repoPath: dir });
    assert.equal(invalid.confidence, "UNSAFE");
    assert.ok(invalid.adapterBlockers?.some(reason => reason.includes("Invalid importer")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("uses local importer options when a package-provided base config is unavailable", async () => {
  const { dir, write } = fixture();
  try {
    write("packages/a/tsconfig.json", JSON.stringify({
      extends: "@tsconfig/node20/tsconfig.json",
      compilerOptions: { moduleResolution: "Bundler", module: "ESNext", paths: { alias: ["./src/value.ts"] } },
      include: ["src/**/*.ts"],
    }));
    write("packages/a/src/value.test.ts", "import {value} from 'alias'; console.log(value);");
    write("packages/a/src/value.ts", "export const value=1;");

    const result = await buildDependencyGraph({ repoPath: dir });
    assert.ok(!result.adapterBlockers?.some(reason => reason.includes("Invalid importer")), JSON.stringify(result.adapterBlockers));
    assert.deepEqual(result.graph.dependenciesOf("packages/a/src/value.test.ts"), ["packages/a/src/value.ts"]);

    write("packages/a/tsconfig.json", JSON.stringify({ extends: "./missing-base.json", include: ["src/**/*.ts"] }));
    const invalidLocalBase = await buildDependencyGraph({ repoPath: dir });
    assert.ok(invalidLocalBase.adapterBlockers?.some(reason => reason.includes("Invalid importer")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("routes npm projects while retaining entire type and property suites", () => {
  const { dir, write } = fixture();
  try {
    write("package.json", JSON.stringify({ workspaces: ["packages/a"] }));
    // Package-manager selection follows lockfiles; remove the pnpm declaration.
    rmSync(join(dir, "pnpm-lock.yaml")); rmSync(join(dir, "pnpm-workspace.yaml"));
    write("package-lock.json", "{}");
    write("packages/a/package.json", JSON.stringify({ scripts: { test: "vitest" }, devDependencies: { vitest: "4.1.8" } }));
    write("packages/a/vitest.config.ts", "export default {test:{projects:[{extends:true,test:{name:'runtime',include:['src/**/*.test.ts']}},{extends:true,test:{name:'types',include:['src/**/*.test-d.ts']}},{extends:true,test:{name:'prop',include:['src/**/*.test-prop.ts']}}]}};");
    const plan = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["packages/a/src/value.test.ts"]);
    assert.equal(plan.refusalReason, undefined);
    assert.equal(plan.commands.length, 3);
    assert.ok(plan.commands.every(command => command.executable === "npm" && command.args.includes("--offline") && command.args.includes("--workspace=packages/a")));
    assert.ok(plan.commands[0]!.args.includes("src/value.test.ts"));
    assert.ok(!plan.commands[1]!.args.includes("src/value.test.ts"));
    assert.deepEqual(plan.commands.map(command => command.args[command.args.indexOf("--project") + 1]), ["runtime", "types", "prop"]);
    write("packages/a/vitest.config.ts", "export default {test:{projects:[{extends:true,test:{name:'runtime',include:['src/**/*.test.ts'],isolate:false}}]}};");
    const shared = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["packages/a/src/value.test.ts"]);
    assert.equal(shared.commands.length, 0);
    assert.match(shared.refusalReason!, /safely narrowed/, "non-isolated project must run in full");
    for (const source of ["export default {test:{projects:other}}", "export default {test:{projects:[{extends:true,test:{name:'runtime',include:patterns}}]}}", "export default {test:{projects:[...other]}}"] ) {
      write("packages/a/vitest.config.ts", source);
      assert.ok(planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["packages/a/src/value.test.ts"]).refusalReason);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

it("keeps non-isolated workspace files in one full invocation", () => {
  const { dir, write } = fixture();
  try {
    write("packages/a/vitest.config.ts", "export default {test:{include:['src/**/*.test.ts'],isolate:false}};");
    write("packages/a/src/other.test.ts", "export const other=1;");
    const plan = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["packages/a/src/value.test.ts"]);
    assert.equal(plan.refusalReason, undefined);
    assert.deepEqual(plan.commands[0]!.args, ["--dir", "packages/a", "exec", "vitest", "run", "--typecheck"]);
    assert.deepEqual(plan.groups[0]!.paths, ["packages/a/src/other.test.ts", "packages/a/src/value.test.ts"]);
    assert.ok(!plan.commands[0]!.args.includes("src/value.test.ts"));
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
