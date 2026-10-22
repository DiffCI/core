// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { infrastructureRole, isImplicitlyLoadedFile, referencePattern, referenceTokens, resolveFileReferences, testScriptClosure, type ReferenceResolutionInput } from "../../src/repo/file-references.js";
import { workflowFeedsTests, workflowMayRunTests } from "../../src/repo/workflow-test-steps.js";
import { analyzeGitDelta, packageJsonChangeKind } from "../../src/git/git-diff.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";

function input(files: Record<string, string>, graph: string[] = Object.keys(files).filter((p) => /\.[cm]?[jt]s$/.test(p))): ReferenceResolutionInput {
  return {
    files: Object.keys(files).sort(),
    read: (path) => files[path],
    isTestFile: (path) => /\.test\.[cm]?[jt]s$/.test(path),
    isDocumentation: (path) => /\.mdx?$/.test(path),
    inGraph: (path) => graph.includes(path),
    isCodeFile: (path) => /\.[cm]?[jt]sx?$/.test(path),
    workflowFeedsTests: (content, names) => workflowFeedsTests(content, names),
  };
}

describe("reference tokens", () => {
  it("names the path, its basename and every ancestor", () => {
    assert.deepEqual(referenceTokens("site/docs/a.html").map((t) => t.value).sort(), ["a.html", "docs", "site", "site/docs", "site/docs/a.html"]);
  });
  it("requires quotes or slashes around a bare directory name", () => {
    const pattern = referencePattern(referenceTokens("site/a.html").filter((t) => t.value === "site"));
    assert.ok(pattern.test(`join(root, "site")`));
    assert.ok(pattern.test("new URL('../site/', import.meta.url)"));
    assert.ok(!pattern.test("// the site is served by the worker"));
    assert.ok(!pattern.test("const site = 1"));
  });
  it("accepts whitespace around a name with an extension, as on a command line", () => {
    const pattern = referencePattern(referenceTokens("scripts/train.py").filter((t) => t.value === "train.py"));
    assert.ok(pattern.test(`spawnSync("python3 train.py --check")`));
    assert.ok(!pattern.test("retrain.pyc"));
  });
});

describe("implicitly loaded and infrastructure files", () => {
  it("never reference-resolves files tooling loads by convention", () => {
    for (const path of [".gitignore", ".env", ".env.local", "tsconfig.base.json", "ops/cloudflare/wrangler.toml", "ops/Dockerfile.worker", "vitest.config.ts", "infra/main.tf"]) {
      assert.equal(isImplicitlyLoadedFile(path), true, path);
    }
    for (const path of [".env.example", "site/index.html", "scripts/train.py", "ops/cloudflare-d1/route-coverage.json"]) {
      assert.equal(isImplicitlyLoadedFile(path), false, path);
    }
  });
  it("splits infrastructure trees into definitions, code, documentation and data", () => {
    assert.equal(infrastructureRole("ops/cloudflare/wrangler.jsonc"), "definition");
    assert.equal(infrastructureRole("ops/cloudflare-builder/src/contract.test.mjs"), "code");
    assert.equal(infrastructureRole("ops/runbooks/rollback.md"), "documentation");
    assert.equal(infrastructureRole("ops/cloudflare-d1/production-route-coverage.json"), "data");
    assert.equal(infrastructureRole("src/ops.ts"), undefined);
    assert.equal(infrastructureRole("Dockerfile"), "definition");
  });
});

describe("resolveFileReferences", () => {
  it("selects the tests that read a directory containing the file", () => {
    const result = resolveFileReferences("site/docs/a.html", input({
      "site/docs/a.html": "<html></html>",
      "tests/site/seo.test.ts": `const site = path.join(root, "site");`,
      "tests/unrelated.test.ts": `import { x } from "../src/x.js";`,
      "docs/site.md": "See site/docs/a.html",
    }));
    assert.deepEqual(result.unresolvable, []);
    assert.deepEqual(result.tests, ["tests/site/seo.test.ts"]);
  });
  it("returns graph code readers so their dependent tests can be selected", () => {
    const result = resolveFileReferences("src/product/schema.sql", input({
      "src/product/schema.sql": "create table t (id int);",
      "src/product/store.ts": `readFileSync(new URL("./schema.sql", import.meta.url))`,
    }));
    assert.deepEqual(result.code, ["src/product/store.ts"]);
    assert.deepEqual(result.unresolvable, []);
  });
  it("follows non-code readers, such as a shell script a test runs", () => {
    const result = resolveFileReferences("fixtures/data.csv", input({
      "fixtures/data.csv": "a,b",
      "scripts/load.sh": "cat fixtures/data.csv",
      "tests/load.test.ts": `execFileSync("bash", ["scripts/load.sh"])`,
    }));
    assert.deepEqual(result.tests, ["tests/load.test.ts"]);
  });
  it("follows second-hand readers by name only, not by their directories", () => {
    const result = resolveFileReferences("package.json", input({
      "package.json": "{}",
      "tests/fixtures/cases/other-repo.json": `{ "changed": ["package.json"] }`,
      "tests/everything.test.ts": `readdirSync(join(root, "tests", "fixtures"))`,
      "tests/version.test.ts": `readFileSync("package.json")`,
    }));
    // The fixture names a different repository's package.json; listing the fixtures directory does
    // not make every fixture-reading test a reader of this one.
    assert.deepEqual(result.unresolvable, []);
    assert.deepEqual(result.tests, ["tests/version.test.ts"]);
  });

  it("fails closed when nothing names the file", () => {
    const result = resolveFileReferences("scripts/orphan.py", input({ "scripts/orphan.py": "print(1)", "tests/a.test.ts": "x" }));
    assert.match(result.unresolvable[0] ?? "", /no test or source file names/);
  });
  it("follows a reader outside the dependency graph to whatever runs it", () => {
    // Read only by a script nothing in the suite runs: the suite cannot observe it.
    const orphan = resolveFileReferences("data/x.json", input({ "data/x.json": "{}", "tools/read.ts": `read("data/x.json")` }, []));
    assert.deepEqual(orphan.unresolvable, []);
    assert.deepEqual(orphan.tests, []);
    // Named only by markup, nothing that can run: the reader is unknown, so it stays unknown.
    const linked = resolveFileReferences("site/a.svg", input({ "site/a.svg": "<svg/>", "site/index.html": `<img src="/a.svg">` }, []));
    assert.match(linked.unresolvable[0] ?? "", /no test or source file names/);
    const run = resolveFileReferences("site/index.html", input({
      "site/index.html": "<html></html>",
      "scripts/check-boundary.mjs": `readFileSync("site/index.html")`,
      "tests/boundary.test.ts": `execFileSync(process.execPath, ["scripts/check-boundary.mjs"])`,
    }, ["tests/boundary.test.ts"]));
    assert.deepEqual(run.unresolvable, []);
    assert.deepEqual(run.tests, ["tests/boundary.test.ts"]);
    const inTestScript = resolveFileReferences("site/index.html", input({
      "site/index.html": "<html></html>",
      "scripts/check-boundary.mjs": `readFileSync("site/index.html")`,
      "package.json": JSON.stringify({ scripts: { test: "node scripts/check-boundary.mjs && node --test" } }),
    }, []));
    assert.match(inTestScript.unresolvable[0] ?? "", /runs scripts\/check-boundary\.mjs as part of its test script/);
  });
  it("fails closed when npm test runs a script that names the file", () => {
    const result = resolveFileReferences("scripts/check.py", input({
      "scripts/check.py": "print(1)",
      "package.json": JSON.stringify({ scripts: { test: "npm run lint && node --test", lint: "python3 scripts/check.py" } }),
      "tests/a.test.ts": `"scripts/check.py"`,
    }));
    assert.match(result.unresolvable[0] ?? "", /runs scripts\/check\.py as part of its test script/);
  });
  it("ignores package scripts outside the test closure and workflows that run no tests", () => {
    const result = resolveFileReferences("scripts/train.py", input({
      "scripts/train.py": "print(1)",
      "package.json": JSON.stringify({ scripts: { test: "node --test", train: "python3 scripts/train.py" } }),
      ".github/workflows/train.yml": "on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: python3 scripts/train.py\n      - run: npm test\n",
      "tests/train.test.ts": `spawn("python3", ["scripts/train.py"])`,
    }));
    // The workflow runs the file before the test step in the same job, so it may prepare the suite.
    assert.match(result.unresolvable[0] ?? "", /\.github\/workflows\/train\.yml names/);
    const standalone = resolveFileReferences("scripts/train.py", input({
      "scripts/train.py": "print(1)",
      ".github/workflows/train.yml": "on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: python3 scripts/train.py\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: python3 scripts/train.py\n",
      "tests/train.test.ts": `spawn("python3", ["scripts/train.py"])`,
    }));
    // After the tests, or in a job without tests, it is a separate CI check.
    assert.deepEqual(standalone.unresolvable, []);
    const noWorkflow = resolveFileReferences("scripts/train.py", input({
      "scripts/train.py": "print(1)",
      "package.json": JSON.stringify({ scripts: { test: "node --test", train: "python3 scripts/train.py" } }),
      ".github/workflows/notify.yml": "on: push\njobs:\n  n:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo scripts/train.py changed\n",
      "tests/train.test.ts": `spawn("python3", ["scripts/train.py"])`,
    }));
    assert.deepEqual(noWorkflow.unresolvable, []);
    assert.deepEqual(noWorkflow.tests, ["tests/train.test.ts"]);
  });
});

describe("workflowFeedsTests", () => {
  const names = /data\.json/;
  const job = (steps: string, extra = "") => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
  it("is true only when the naming step precedes a test step, or configures a testing job", () => {
    assert.equal(workflowFeedsTests(job("      - run: cp data.json fixtures/\n      - run: npm test\n"), names), true);
    assert.equal(workflowFeedsTests(job("      - run: npm test\n      - run: cp data.json out/\n"), names), false);
    assert.equal(workflowFeedsTests(job("      - run: node scripts/check.mjs data.json\n      - run: node scripts/other-check.mjs\n"), names), false);
    assert.equal(workflowFeedsTests(job("      - run: npm test\n", "    env:\n      FIXTURE: data.json\n"), names), true);
    assert.equal(workflowFeedsTests(job("      - run: cp data.json x\n      - uses: some/test-action@v1\n"), names), true);
    assert.equal(workflowFeedsTests("jobs:\n  call:\n    uses: ./.github/workflows/ci.yml\n    with:\n      file: data.json\n", names), true);
    assert.equal(workflowFeedsTests("not: [valid", names), true);
  });
});

describe("testScriptClosure", () => {
  it("follows lifecycle hooks and named scripts", () => {
    const closure = testScriptClosure({ pretest: "npm run build", build: "tsc", test: "node --test", release: "npm publish", prepare: "husky" });
    assert.deepEqual([...closure].sort(), ["build", "prepare", "pretest", "test"]);
  });
});

describe("workflowMayRunTests", () => {
  const wf = (steps: string) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  it("is false only for recognised non-test steps", () => {
    assert.equal(workflowMayRunTests(wf("      - uses: actions/checkout@v4\n      - uses: github/codeql-action/analyze@v3\n      - run: gh release create v1\n")), false);
    assert.equal(workflowMayRunTests(wf("      - run: npx wrangler deploy --config wrangler.site.jsonc\n")), false);
  });
  it("is true for test runners, test scripts, repository files and unknown actions", () => {
    assert.equal(workflowMayRunTests(wf("      - run: npm test\n")), true);
    assert.equal(workflowMayRunTests(wf("      - run: npm run check\n"), { check: "npm run lint && npm test", lint: "eslint ." }), true);
    assert.equal(workflowMayRunTests(wf("      - run: npm run build\n"), { build: "tsc" }), false);
    assert.equal(workflowMayRunTests(wf("      - run: node scripts/deploy.mjs\n")), true);
    assert.equal(workflowMayRunTests(wf("      - uses: ./.github/actions/setup\n")), true);
    assert.equal(workflowMayRunTests(wf("      - uses: DiffCI/core@v1\n")), true);
    assert.equal(workflowMayRunTests("jobs:\n  call:\n    uses: ./.github/workflows/ci.yml\n"), true);
    assert.equal(workflowMayRunTests("not: [valid"), true);
    assert.equal(workflowMayRunTests(wf("      - run: npx diffci verify --json\n")), true);
  });
});

describe("packageJsonChangeKind", () => {
  const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: "x", scripts: { test: "node --test", release: "npm publish" }, dependencies: { a: "1" }, ...fields });
  it("classifies version, files and non-test scripts as data", () => {
    assert.equal(packageJsonChangeKind(pkg({ version: "1.0.0" }), pkg({ version: "1.0.1" })), "data");
    assert.equal(packageJsonChangeKind(pkg({ files: ["dist"] }), pkg({ files: ["dist", "src"] })), "data");
    assert.equal(packageJsonChangeKind(pkg({}), pkg({ scripts: { test: "node --test", release: "npm publish --tag next" } })), "data");
  });
  it("keeps dependencies and the test closure behavioral", () => {
    assert.equal(packageJsonChangeKind(pkg({}), pkg({ dependencies: { a: "2" } })), "behavioral");
    assert.equal(packageJsonChangeKind(pkg({}), pkg({ scripts: { test: "node --test --test-concurrency=1", release: "npm publish" } })), "behavioral");
    assert.equal(packageJsonChangeKind(pkg({}), pkg({ scripts: { test: "node --test", release: "npm publish", pretest: "tsc" } })), "behavioral");
    assert.equal(packageJsonChangeKind(pkg({}), "{"), "behavioral");
  });
  it("keeps descriptive fields as metadata", () => {
    assert.equal(packageJsonChangeKind(pkg({ description: "a" }), pkg({ description: "b" })), "metadata");
  });
});

describe("end to end on a temporary repository", () => {
  function repo(files: Record<string, string>): string {
    const dir = join(tmpdir(), `diffci-ref-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(dir, files);
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    return dir;
  }
  function write(dir: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  }
  async function analyze(dir: string, change: Record<string, string>) {
    const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, change);
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const head = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha: base, headSha: head });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    return new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
  }
  const base = {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", scripts: { test: "node --test", deploy: "wrangler deploy" } }, null, 2),
    "src/util.js": "export const one = 1;\n",
    "src/util.test.js": `import { one } from "./util.js";\nimport test from "node:test";\ntest("one", () => {});\n`,
    "site/index.html": "<html></html>\n",
    "tests/site.test.js": `import { readdirSync } from "node:fs";\nimport test from "node:test";\ntest("pages", () => readdirSync(new URL("../site/", import.meta.url)));\n`,
    "tests/version.test.js": `import { readFileSync } from "node:fs";\nimport test from "node:test";\ntest("v", () => JSON.parse(readFileSync("package.json", "utf8")).version);\n`,
    ".github/workflows/deploy.yml": "on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npx wrangler deploy\n",
    ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm test\n",
    "ops/cloudflare/wrangler.toml": "name = 'x'\n",
    "ops/cloudflare/README.md": "# ops\n",
    "orphan/notes.txt": "x\n",
  };

  it("selects the readers of changed site HTML instead of falling back", async () => {
    const dir = repo(base);
    try {
      const impact = await analyze(dir, { "site/index.html": "<html>2</html>\n" });
      assert.deepEqual(impact.fallbackReasons, []);
      assert.deepEqual(impact.affectedTests.map((t) => t.path), ["tests/site.test.js"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("selects tests that read package.json for a version bump", async () => {
    const dir = repo(base);
    try {
      const impact = await analyze(dir, { "package.json": base["package.json"].replace('"1.0.0"', '"1.0.1"') });
      assert.deepEqual(impact.fallbackReasons, []);
      assert.deepEqual(impact.affectedTests.map((t) => t.path), ["tests/version.test.js"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("narrows a deploy-only workflow, but not one that runs tests, and names the file", async () => {
    const dir = repo(base);
    try {
      const deploy = await analyze(dir, { ".github/workflows/deploy.yml": base[".github/workflows/deploy.yml"].replace("deploy\n", "deploy --env staging\n") });
      // Nothing names the workflow, so it stays unknown rather than silently selecting nothing.
      assert.deepEqual(deploy.fallbackReasons, ["Unknown changed file: .github/workflows/deploy.yml"]);
      const ci = await analyze(dir, { ".github/workflows/ci.yml": base[".github/workflows/ci.yml"].replace("npm test", "npm test -- --test-concurrency=1") });
      assert.ok(ci.fallbackReasons.includes("GitHub workflow definition(s) changed; full validation required: .github/workflows/ci.yml"));
      assert.ok(ci.fallbackReasons.includes("Configuration file(s) changed; full validation required: .github/workflows/ci.yml"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("treats ops documentation as documentation and ops definitions as global", async () => {
    const dir = repo(base);
    try {
      const docs = await analyze(dir, { "ops/cloudflare/README.md": "# ops 2\n" });
      assert.deepEqual(docs.fallbackReasons, []);
      const definition = await analyze(dir, { "ops/cloudflare/wrangler.toml": "name = 'y'\n" });
      assert.deepEqual(definition.fallbackReasons, ["Infrastructure definition(s) changed; full validation required: ops/cloudflare/wrangler.toml"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps an unreferenced file unknown", async () => {
    const dir = repo(base);
    try {
      const impact = await analyze(dir, { "orphan/notes.txt": "y\n" });
      assert.deepEqual(impact.fallbackReasons, ["Unknown changed file: orphan/notes.txt"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
