// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { planSelectiveTestCommands, workspaceVitestScript } from "../../src/planner/test-command.js";
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

/** LobeHub's shape (2026-11-04): no lockfile, pnpm named in package.json, the app and server suites at the
 * root as inline Vitest projects, and workspace packages beside them, some with other test scripts. */
function rootProjectsFixture() {
  const dir = mkdtempSync(join(tmpdir(), "diffci-root-projects-"));
  const write = (path: string, content: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); };
  write("package.json", JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "npm run test-app && npm run test-server", "test-app": "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
  write("pnpm-workspace.yaml", "packages:\n  - 'packages/**'\n  - .\n  - e2e\n");
  write("vitest.config.mts", `import tsconfigPaths from 'vite-tsconfig-paths';
const exclude = ['**/node_modules/**', '**/apps/desktop/**', '**/packages/**', '**/e2e/**'];
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['.', './apps/share'] })],
  test: {
    alias,
    environment: 'happy-dom',
    exclude,
    projects: [
      { extends: true, test: { name: 'app', exclude: [...exclude, '**/apps/server/**'] } },
      { extends: true, test: { name: 'server', environment: 'node', include: ['**/apps/server/**/*.{test,spec}.?(c|m)[jt]s?(x)'] } },
    ],
    globals: true,
    setupFiles: './tests/setup.ts',
  },
});`);
  for (const path of ["src/store/a.test.ts", "src/routes/(main)/page.test.tsx", "apps/server/src/router.test.ts", "apps/desktop/src/main/app.test.ts"]) write(path, "import {test} from 'vitest'; test('x',()=>{});");
  write("packages/p/package.json", JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
  write("packages/p/vitest.config.ts", "export default {test:{include:['src/**/*.test.ts']}};");
  write("packages/p/src/p.test.ts", "import {test} from 'vitest'; test('p',()=>{});");
  write("e2e/package.json", JSON.stringify({ scripts: { test: "bun run test:unit && cucumber-js" }, devDependencies: { vitest: "4.1.8" } }));
  write("e2e/src/flow.test.ts", "import {test} from 'vitest'; test('e',()=>{});");
  return { dir, write };
}

it("routes root-package tests through the root's inline Vitest projects beside workspace packages", () => {
  const { dir } = rootProjectsFixture();
  try {
    const profile = analyzeRepository({ repoPath: dir });
    assert.equal(profile.packageManager, "pnpm");
    assert.equal(profile.lockfile, undefined);
    const config = profile.testRunnerConfigs!.find(c => c.file === "vitest.config.mts")!;
    assert.deepEqual(config.projects!.map(p => [p.name, p.runtimeSelectionSafe]), [["app", true], ["server", true]]);
    const plan = planSelectiveTestCommands(profile, ["apps/server/src/router.test.ts", "packages/p/src/p.test.ts", "src/routes/(main)/page.test.tsx", "src/store/a.test.ts"]);
    assert.equal(plan.refusalReason, undefined);
    assert.deepEqual(plan.commands.map(c => [c.executable, ...c.args].join(" ")), [
      "pnpm exec vitest run --config vitest.config.mts --project app src/routes/(main)/page.test.tsx src/store/a.test.ts",
      "pnpm exec vitest run --config vitest.config.mts --project server apps/server/src/router.test.ts",
      "pnpm --dir packages/p exec vitest run --config vitest.config.ts src/p.test.ts",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("still refuses a selected test in a package whose script it cannot narrow", () => {
  const { dir } = rootProjectsFixture();
  try {
    const plan = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["e2e/src/flow.test.ts", "src/store/a.test.ts"]);
    assert.match(plan.refusalReason!, /single declared Vitest phase/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("treats root projects it cannot read as ambiguous rather than routing by lifted globs", () => {
  const { dir, write } = rootProjectsFixture();
  try {
    write("vitest.config.mts", "export default {test:{projects:[{extends:true,test:{name:'app',include:patterns}}]}};");
    const plan = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["src/store/a.test.ts"]);
    assert.match(plan.refusalReason!, /statically declared/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reports tests every including project excludes as outside the full suite, not as refusals", () => {
  const { dir, write } = rootProjectsFixture();
  try {
    const selected = ["apps/desktop/src/main/app.test.ts", "src/store/a.test.ts"];
    const plan = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), selected);
    assert.equal(plan.refusalReason, undefined);
    assert.deepEqual(plan.commands.map(c => c.args.join(" ")), ["exec vitest run --config vitest.config.mts --project app src/store/a.test.ts"]);
    assert.deepEqual(plan.outsideSuitePaths, ["apps/desktop/src/main/app.test.ts"]);
    // A test script that could run the excluded files keeps the refusal.
    write("package.json", JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run && node --test apps/desktop" }, devDependencies: { vitest: "4.1.8" } }));
    assert.match(planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), selected).refusalReason!, /no declared Vitest project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("parses launcher, config and output-only forms of a workspace Vitest script", () => {
  assert.deepEqual(workspaceVitestScript("bunx vitest run --config vitest.config.mts --silent='passed-only'"), { config: "vitest.config.mts", typecheck: false });
  assert.deepEqual(workspaceVitestScript("vitest --run"), { typecheck: false });
  assert.deepEqual(workspaceVitestScript("pnpm exec vitest run -c ./vitest.unit.config.ts --typecheck"), { config: "vitest.unit.config.ts", typecheck: true });
  for (const script of ["vitest --coverage", "lint && vitest run", "vitest run --config a.ts --config b.ts", "jest", undefined]) assert.equal(workspaceVitestScript(script), undefined, String(script));
});

it("routes a package script that names its config, and leaves a package without a test script to the root suite (2026-11-05)", () => {
  const { dir, write } = rootProjectsFixture();
  try {
    write("pnpm-workspace.yaml", "packages:\n  - 'packages/**'\n  - 'apps/*'\n  - .\n  - e2e\n");
    write("apps/server/package.json", JSON.stringify({ scripts: { build: "tsc" } }));
    write("apps/desktop/package.json", JSON.stringify({ scripts: { test: "vitest --run" }, devDependencies: { vitest: "4.1.8" } }));
    write("apps/desktop/vitest.config.mts", "export default {test:{include:['src/**/*.test.ts']}};");
    write("apps/cli/package.json", JSON.stringify({ scripts: { test: "bunx vitest run --config vitest.config.mts --silent='passed-only'", "test:e2e": "bunx vitest run --config vitest.e2e.config.mts" }, devDependencies: { vitest: "4.1.8" } }));
    write("apps/cli/vitest.config.mts", "export default {test:{include:['src/**/*.test.ts']}};");
    write("apps/cli/vitest.e2e.config.mts", "export default {test:{include:['e2e/**/*.test.ts']}};");
    write("apps/cli/src/c.test.ts", "import {test} from 'vitest'; test('c',()=>{});");
    write("apps/cli/e2e/flow.test.ts", "import {test} from 'vitest'; test('f',()=>{});");
    const plan = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), ["apps/cli/e2e/flow.test.ts", "apps/cli/src/c.test.ts", "apps/desktop/src/main/app.test.ts", "apps/server/src/router.test.ts"]);
    assert.equal(plan.refusalReason, undefined);
    assert.deepEqual(plan.commands.map(c => [c.executable, ...c.args].join(" ")), [
      "pnpm exec vitest run --config vitest.config.mts --project server apps/server/src/router.test.ts",
      "pnpm --dir apps/cli exec vitest run --config vitest.config.mts src/c.test.ts",
      "pnpm --dir apps/desktop exec vitest run --config vitest.config.mts src/main/app.test.ts",
    ]);
    assert.deepEqual(plan.outsideSuitePaths, ["apps/cli/e2e/flow.test.ts"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
