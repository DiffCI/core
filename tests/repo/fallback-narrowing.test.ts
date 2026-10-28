// SPDX-License-Identifier: MIT
// Rules added from the DentalPresence replay (2026-10-28): test-list edits, dependency bumps, word-level
// path naming, and test-script phases.
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeGitDelta, packageJsonChange, testListEdit } from "../../src/git/git-diff.js";
import { npmLockAffectedDependencies } from "../../src/repo/npm-lockfile.js";
import { contentNamesPath, referencePattern, referenceTokens, repositoryFileReader, resolveFileReferences, scriptNamesPath, type ReferenceResolutionInput } from "../../src/repo/file-references.js";
import { workflowFeedsTests } from "../../src/repo/workflow-test-steps.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

const pattern = (path: string, ancestors = true) => referencePattern(referenceTokens(path, { ancestors }));

describe("testListEdit", () => {
  const list = "tsx --conditions react-server --test ops/a.test.mjs scripts/b.test.mjs \"src/**/*.test.ts\" && node scripts/test-security.js";
  it("reports test files added to or removed from a --test file list", () => {
    assert.deepEqual(testListEdit(list, list.replace("ops/a.test.mjs", "ops/a.test.mjs ops/new.test.mjs")), { added: ["ops/new.test.mjs"], removed: [] });
    assert.deepEqual(testListEdit(list, list.replace("scripts/b.test.mjs ", "")), { added: [], removed: ["scripts/b.test.mjs"] });
  });
  it("rejects every other edit", () => {
    assert.equal(testListEdit(list, list.replace("--test", "--test --test-concurrency=1")), undefined);
    assert.equal(testListEdit(list, list.replace("ops/a.test.mjs", "ops/a.test.mjs ops/helper.mjs")), undefined);
    assert.equal(testListEdit(list, list.replace("node scripts/test-security.js", "node scripts/test-security.js extra.test.mjs")), undefined);
    assert.equal(testListEdit(list, `${list} && node scripts/more.js`), undefined);
    assert.equal(testListEdit(list, list.replace("ops/a.test.mjs scripts/b.test.mjs", "scripts/b.test.mjs ops/a.test.mjs")), undefined);
  });
});

describe("packageJsonChange", () => {
  const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: "x", scripts: { test: "node --test a.test.js" }, dependencies: { a: "1.0.0" }, ...fields });
  it("treats a test-list edit as data and reports the added tests", () => {
    assert.deepEqual(packageJsonChange(pkg({}), pkg({ scripts: { test: "node --test a.test.js b.test.js" } })), { kind: "data", testScriptAddedPaths: ["b.test.js"], changedDependencies: [] });
  });
  it("reports dependency-only edits by name and keeps other behavioral fields behavioral", () => {
    assert.deepEqual(packageJsonChange(pkg({}), pkg({ dependencies: { a: "1.1.0", b: "2.0.0" } })), { kind: "dependencies", testScriptAddedPaths: [], changedDependencies: ["a", "b"] });
    assert.equal(packageJsonChange(pkg({}), pkg({ peerDependencies: { a: "1" } })).kind, "behavioral");
    assert.equal(packageJsonChange(pkg({}), pkg({ overrides: { a: "1" } })).kind, "behavioral");
  });
});

describe("npmLockAffectedDependencies", () => {
  const lock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { a: "^1", b: "^1" } }, ...packages } });
  const base = {
    "node_modules/a": { version: "1.0.0", dependencies: { shared: "^1" } },
    "node_modules/b": { version: "1.0.0" },
    "node_modules/shared": { version: "1.0.0" },
    "node_modules/c": { version: "1.0.0", peerDependencies: { b: "^1" } },
  };
  it("attributes a direct bump, and a transitive bump to every direct dependency that reaches it", () => {
    assert.deepEqual(npmLockAffectedDependencies(lock(base), lock({ ...base, "node_modules/b": { version: "1.1.0" } }), ["a", "b", "c"]), ["b", "c"]);
    assert.deepEqual(npmLockAffectedDependencies(lock(base), lock({ ...base, "node_modules/shared": { version: "1.0.1" } }), ["a", "b", "c"]), ["a"]);
  });
  it("attributes nested installs through Node resolution", () => {
    const after = { ...base, "node_modules/a/node_modules/shared": { version: "2.0.0" }, "node_modules/a": { version: "1.0.0", dependencies: { shared: "^2" } } };
    assert.deepEqual(npmLockAffectedDependencies(lock(base), lock(after), ["a", "b", "c"]), ["a"]);
  });
  it("returns undefined for what it does not model", () => {
    assert.equal(npmLockAffectedDependencies(lock(base), lock({ ...base, "node_modules/orphan": { version: "1.0.0" } }), ["a", "b", "c"]), undefined);
    assert.equal(npmLockAffectedDependencies(lock(base), lock({ ...base, "packages/web": { version: "1.0.0" } }), ["a", "b", "c"]), undefined);
    assert.equal(npmLockAffectedDependencies(JSON.stringify({ lockfileVersion: 1, dependencies: {} }), lock(base), ["a"]), undefined);
    assert.equal(npmLockAffectedDependencies("{", lock(base), ["a"]), undefined);
  });
});

describe("word-level naming", () => {
  it("does not read a sibling file in a script as naming its directory", () => {
    const target = "ops/cloudflare/api.json";
    const body = "tsx --test ops/cloudflare/src/a.test.mjs \"scripts/[!d]*.test.ts\" && node scripts/test-security.js";
    assert.equal(scriptNamesPath(body, target, pattern(target)), false);
    assert.equal(scriptNamesPath("node scripts/check.mjs ops/cloudflare", target, pattern(target)), true);
    assert.equal(scriptNamesPath("eslint ops/cloudflare/", target, pattern(target)), true);
    assert.equal(scriptNamesPath("cat ops/*/api.json", target, pattern(target)), true);
    // Bracket classes are widened, so an unsupported class can only over-match.
    assert.equal(scriptNamesPath("node --test \"scripts/[!d]*.test.ts\"", "scripts/check.test.ts", pattern("scripts/check.test.ts")), true);
    assert.equal(scriptNamesPath("node -e \"require('./ops/cloudflare/x.js')\"", target, pattern(target)), true);
  });
  it("resolves relative paths in content from the reader's directory or the root", () => {
    const target = "ops/cloudflare/src/index.js";
    assert.equal(contentNamesPath(`{ "main": "./src/index.js" }`, "ops/builder/wrangler.jsonc", target, pattern(target), true), false);
    assert.equal(contentNamesPath(`{ "main": "./src/index.js" }`, "ops/cloudflare/wrangler.jsonc", target, pattern(target), true), true);
    assert.equal(contentNamesPath(`readFile(new URL("./index.js", import.meta.url))`, "ops/cloudflare/src/a.test.mjs", target, pattern(target), true), true);
    assert.equal(contentNamesPath(`join(root, "src", "index.js")`, "scripts/x.mjs", target, pattern(target), true), true);
    assert.equal(contentNamesPath("see ops/cloudflare/src/other.js", "scripts/x.mjs", target, pattern(target), true), false);
    assert.equal(contentNamesPath("`${root}/ops/cloudflare/src/index.js`", "scripts/x.mjs", target, pattern(target), true), true);
  });
});

describe("test-script phases", () => {
  function input(files: Record<string, string>, testPhases: boolean): ReferenceResolutionInput {
    return {
      files: Object.keys(files).sort(), read: (path) => files[path],
      isTestFile: (path) => /\.test\.[cm]?[jt]s$/.test(path), isDocumentation: (path) => /\.mdx?$/.test(path),
      inGraph: () => false, isCodeFile: (path) => /\.[cm]?[jt]sx?$/.test(path),
      workflowFeedsTests: (content, names) => workflowFeedsTests(content, names), testPhases,
    };
  }
  const files = {
    "data/rules.json": "{}",
    "scripts/test-security.js": `fs.readdirSync(path.join(root, "data"))`,
    "package.json": JSON.stringify({ scripts: { test: "node --test && node scripts/test-security.js" } }),
  };
  it("covers a reader the test script runs directly by returning that phase", () => {
    const result = resolveFileReferences("data/rules.json", input(files, true));
    assert.deepEqual(result.unresolvable, []);
    assert.deepEqual(result.phases, ["node scripts/test-security.js"]);
  });
  it("fails closed without the option, or when the script also names the reader another way", () => {
    assert.match(resolveFileReferences("data/rules.json", input(files, false)).unresolvable[0] ?? "", /runs scripts\/test-security\.js/);
    const piped = { ...files, "package.json": JSON.stringify({ scripts: { test: "node --test && node scripts/test-security.js | tee log" } }) };
    assert.equal(resolveFileReferences("data/rules.json", input(piped, true)).phases.length, 0);
  });
});

describe("dependency bumps end to end", () => {
  function write(dir: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  }
  const lock = (versions: Record<string, string>) => JSON.stringify({
    name: "fixture", lockfileVersion: 3,
    packages: { "": { dependencies: { left: "^1", right: "^1" }, devDependencies: { tooling: "^1" } },
      ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])) },
  }, null, 2);
  const manifest = (left: string, tooling = "^1") => JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" },
    dependencies: { left, right: "^1" }, devDependencies: { tooling } }, null, 2);
  const files = {
    "package.json": manifest("^1"),
    "package-lock.json": lock({ left: "1.0.0", right: "1.0.0", tooling: "1.0.0" }),
    "src/uses-left.js": `import left from "left";\nexport const value = left;\n`,
    "src/uses-left.test.js": `import { value } from "./uses-left.js";\nimport test from "node:test";\ntest("l", () => value);\n`,
    "src/uses-right.test.js": `import right from "right";\nimport test from "node:test";\ntest("r", () => right);\n`,
    // package.json is still resolved by reference: whoever reads it is selected too.
    "tests/manifest.test.js": `import { readFileSync } from "node:fs";\nimport test from "node:test";\ntest("m", () => readFileSync("package.json", "utf8"));\n`,
  };
  async function analyze(dir: string, change: Record<string, string>) {
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, change);
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    return { delta: delta.delta, impact: new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) }) };
  }
  it("selects the tests that import a bumped package, and falls back for one nothing imports", async () => {
    const dir = join(tmpdir(), `diffci-deps-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
      write(dir, files);
      execSync("git add -A && git commit --quiet -m base", { cwd: dir });
      const bump = await analyze(dir, { "package.json": manifest("^1.1.0"), "package-lock.json": lock({ left: "1.1.0", right: "1.0.0", tooling: "1.0.0" }) });
      assert.deepEqual(bump.delta.analysis.changedDependencies, ["left"]);
      assert.deepEqual(bump.impact.evidence.filter((e) => /could not be resolved/.test(e.message)).map((e) => e.message), []);
      assert.deepEqual(bump.impact.fallbackReasons, []);
      assert.deepEqual(bump.impact.affectedTests.map((t) => t.path), ["src/uses-left.test.js", "tests/manifest.test.js"]);
      // Typecheck and build tasks still see that dependencies changed.
      assert.ok(bump.impact.riskSignals.some((signal) => signal.reason === "DEPENDENCY_MANIFEST"));
      const tool = await analyze(dir, { "package.json": manifest("^1.1.0", "^2"), "package-lock.json": lock({ left: "1.1.0", right: "1.0.0", tooling: "2.0.0" }) });
      assert.deepEqual(tool.impact.fallbackReasons, ["Dependency tooling changed and no repository source imports it; full validation required"]);
      // A manifest edit the lockfile does not reflect stays global.
      const unlocked = await analyze(dir, { "package.json": manifest("^1.2.0", "^2") });
      assert.ok(unlocked.impact.fallbackReasons.some((reason) => reason.startsWith("Dependency manifest changed")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
