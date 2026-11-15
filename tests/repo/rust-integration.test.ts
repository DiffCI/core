import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { adapterFiles, REPOSITORY_ADAPTERS } from "../../src/repo/adapters/index.js";
import { analyzeRustMetadata, rustAdapter } from "../../src/repo/adapters/rust.js";
import type { AdapterContext } from "../../src/repo/adapters/types.js";
import { rustTestInvocation } from "../../src/repo/adapters/rust-invocation.js";
import { buildDependencyGraph, classifyRepositoryProject, hydrateDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { testFileMatcherForProfile } from "../../src/repo/test-discovery.js";
import type { GitDelta, ChangedFile } from "../../src/git/types.js";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-rust-integration-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
function delta(path: string, extra: Partial<ChangedFile> = {}): GitDelta {
  return { baseSha: "base", headSha: "head", files: [{ path, changeType: "modified", ...extra }], directories: [],
    summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false } };
}
const workflow = (run = "cargo test") => `name: test\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ${run}\n`;

test("Rust registers independently and adds only its own targets to the test matcher", () => {
  assert.ok(REPOSITORY_ADAPTERS.includes(rustAdapter));
  assert.equal(rustAdapter.detect({ repoPath: "/unused", files: ["src/app.ts"], profile: {} as never }), false);
  const matcher = testFileMatcherForProfile({ goTestPackages: { "a_test.go": "a" }, rustTestPackages: { "src/lib.rs": "r" } });
  for (const path of ["a_test.go", "src/lib.rs", "a.test.ts"]) assert.ok(matcher(path), path);
  assert.equal(matcher("src/helper.rs"), false);
  // Other languages keep exactly the matcher they had without the Rust adapter.
  const withoutRust = testFileMatcherForProfile({ goTestPackages: { "a_test.go": "a" } });
  for (const path of ["Test.java", "test_a.py", "src/Main.java", "app.py"]) assert.equal(matcher(path), withoutRust(path), path);
});

test("Cargo target build output is excluded without hiding JavaScript target directories", () => {
  for (const rust of [false, true]) {
    const root = fixture({ ...(rust ? { "Cargo.toml": "[workspace]" } : {}), "target/generated.rs": "", "target/a.test.js": "" });
    try { assert.equal(adapterFiles(root).includes("target/a.test.js"), !rust); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Rust invocation evidence accepts only reproducible plain commands", () => {
  const cases: Array<[Record<string, string>, boolean]> = [
    [{ "Cargo.toml": "[workspace]" }, false],
    [{ ".github/workflows/test.yml": workflow() }, true],
    [{ "package.json": JSON.stringify({ scripts: { test: "cargo test" } }) }, true],
    [{ "package.json": JSON.stringify({ scripts: { test: "cargo test", pretest: "setup" } }) }, false],
    ...["cargo test --features extra", "cargo test --workspace", "RUSTFLAGS=x cargo test", "cargo test && echo done", "just test"].map(run => [{ ".github/workflows/test.yml": workflow(run) }, false] as [Record<string, string>, boolean]),
    ...["env: { RUSTFLAGS: x }", "defaults: { run: { working-directory: app } }"].map(context => [{ ".github/workflows/test.yml": `${context}\n${workflow()}` }, false] as [Record<string, string>, boolean]),
    ...["env: { RUSTFLAGS: x }", "shell: bash", "working-directory: app"].map(context => [{ ".github/workflows/test.yml": `${workflow()}        ${context}\n` }, false] as [Record<string, string>, boolean]),
    [{ ".github/workflows/test.yml": workflow().replace("      - run:", "      - run: echo setup\n      - run:") }, false],
    ...["cargo nextest run", "cargo make test", "just test", "./scripts/test.sh", "npm test", "echo cleanup"].flatMap(run => [
      [{ ".github/workflows/test.yml": `${workflow()}      - run: ${run}\n` }, false] as [Record<string, string>, boolean],
      [{ ".github/workflows/test.yml": `${workflow()}  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n` }, false] as [Record<string, string>, boolean],
      [{ ".github/workflows/test.yml": workflow(), ".github/workflows/other.yml": workflow(run) }, false] as [Record<string, string>, boolean],
    ]),
    [{ ".github/workflows/test.yml": `${workflow()}  delegated:\n    uses: org/project/.github/workflows/tests.yml@main\n` }, false],
    ...["./.github/actions/tests", "org/setup@v1", "actions/download-artifact@v4"].flatMap(action => [
      [{ ".github/workflows/test.yml": workflow().replace("      - run:", `      - uses: ${action}\n      - run:`) }, false] as [Record<string, string>, boolean],
      [{ ".github/workflows/test.yml": `${workflow()}      - uses: ${action}\n` }, false] as [Record<string, string>, boolean],
    ]),
    [{ ".github/workflows/test.yml": workflow().replace("      - run:", "        with: { path: elsewhere }\n      - run:") }, false],
    // Ordinary CI around a plain `cargo test`: toolchain and cache actions, a matrix, neutral
    // environment, and lint/format/build steps or jobs that run no tests.
    [{ ".github/workflows/ci.yml": `name: CI
on: [push, pull_request]
env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: 1
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        toolchain: [stable, beta]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: dtolnay/rust-toolchain@master
        with: { toolchain: "\${{ matrix.toolchain }}", components: "clippy, rustfmt" }
      - uses: Swatinem/rust-cache@v2
      - run: cargo build --locked
      - run: cargo test
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
      - run: rustup component add clippy
      - run: cargo fmt --all --check
      - run: cargo clippy --all-targets -- -D warnings
` }, true],
    ...["      - run: cargo clippy && cargo test\n", "        if: github.event_name == 'push'\n", "        continue-on-error: true\n", "        env: { CARGO_TERM_COLOR: always, RUSTDOCFLAGS: x }\n"].map(extra =>
      [{ ".github/workflows/test.yml": `${workflow()}${extra}` }, false] as [Record<string, string>, boolean]),
    [{ ".github/workflows/test.yml": `${workflow()}    if: github.ref == 'refs/heads/main'\n` }, false],
    [{ ".github/workflows/test.yml": `${workflow()}    container: rust:latest\n` }, false],
    ...[
      { lint: "cargo test", test: "just test" },
      { lint: "cargo test" },
      { test: "cargo test", posttest: "./scripts/test.sh" },
      { test: "cargo test", "test:integration": "cargo nextest run" },
      { test: "cargo test", other: "./scripts/test.sh" },
    ].map(scripts => [{ "package.json": JSON.stringify({ scripts }), ".github/workflows/test.yml": workflow() }, false] as [Record<string, string>, boolean]),

  ];
  for (const [files, expected] of cases) {
    const root = fixture(files);
    try { assert.equal(rustTestInvocation(root, Object.keys(files)), expected ? "cargo test" : undefined, JSON.stringify(files)); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("registered Rust graph propagates crate roots and manifests and fails closed on unmodeled changes", async t => {
  const files: Record<string, string> = { "Cargo.toml": '[workspace]\nmembers=["core", "app", "other"]\n', ".github/workflows/test.yml": workflow() };
  for (const name of ["core", "app", "other"]) {
    files[`${name}/Cargo.toml`] = `[package]\nname="${name}"\nversion="0.1.0"\n`;
    files[`${name}/src/lib.rs`] = "pub fn value() {}";
    files[`${name}/src/helper.rs`] = "";
    files[`${name}/tests/api.rs`] = "#[test] fn api() {}";
  }
  files["core/src/lib.rs"] += ' const TEXT: &str = include_str!("../data.txt");';
  files["core/data.txt"] = "fixture";
  const root = fixture(files);
  const packages = ["core", "app", "other"].map(name => ({ id: name, name, manifest_path: join(root, name, "Cargo.toml"), dependencies: [], features: {}, targets: [
    { name, kind: ["lib"], src_path: join(root, name, "src/lib.rs"), test: true, doctest: true },
    { name: "api", kind: ["test"], src_path: join(root, name, "tests/api.rs"), test: true, doctest: false },
  ] }));
  const metadata = JSON.stringify({ packages, workspace_members: packages.map(p => p.id), workspace_default_members: packages.map(p => p.id), workspace_root: root, resolve: { nodes: packages.map(p => ({ id: p.id, dependencies: p.id === "app" ? ["core"] : [] })) } });
  t.mock.method(rustAdapter, "analyze", (context: AdapterContext) => analyzeRustMetadata(context, metadata));
  try {
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    assert.equal(classifyRepositoryProject(root).capable, true);
    assert.deepEqual(graph.profile.goTestPackages, {});
    const restored = hydrateDependencyGraph(JSON.parse(JSON.stringify(graph.graph)), root, graph.profile.testPatterns);
    assert.deepEqual(restored.nodes.filter(n => n.isTest).map(n => n.path), graph.graph.nodes.filter(n => n.isTest).map(n => n.path));
    assert.equal(graph.profile.rustTestInvocation, "cargo test");
    assert.equal(graph.profile.rustTestPackages?.["core/src/lib.rs"], "core");
    for (const path of ["core/src/lib.rs", "core/src/helper.rs", "core/Cargo.toml", "core/data.txt"]) {
      const impact = new ImpactAnalyzer().analyze(delta(path), graph, graph.profile);
      assert.equal(impact.fallbackRequired, false, `${path}: ${impact.fallbackReasons}`);
      assert.deepEqual(impact.affectedTests.map(test => test.path).sort(), ["app/src/lib.rs", "app/tests/api.rs", "core/src/lib.rs", "core/tests/api.rs"]);
    }
    const independent = new ImpactAnalyzer().analyze(delta("other/src/lib.rs"), graph, graph.profile);
    assert.deepEqual(independent.affectedTests.map(test => test.path).sort(), ["other/src/lib.rs", "other/tests/api.rs"]);
    // Documentation follows the shared classification: no tests, no fallback.
    for (const path of ["README.md", "docs/guide.md", "core/CHANGELOG.md"]) {
      const docs = new ImpactAnalyzer().analyze(delta(path), graph, graph.profile);
      assert.equal(docs.fallbackRequired, false, `${path}: ${docs.fallbackReasons}`);
      assert.deepEqual(docs.affectedTests, []);
    }
    for (const change of [delta("Cargo.toml"), delta("Cargo.lock"), delta("app/Cargo.lock"), delta(".github/workflows/test.yml"), delta("data.bin", { changeType: "deleted" }), delta("core/src/lib.rs", { changeType: "renamed", oldPath: "old.rs" }), delta("target/generated.rs")]) {
      const impact = new ImpactAnalyzer().analyze(change, graph, graph.profile);
      assert.equal(impact.fallbackRequired, true, change.files[0]?.path);
      assert.ok(impact.fallbackReasons.some(reason => reason.startsWith("Rust runtime inputs")));
    }
    writeFileSync(join(root, "foreign.js"), "export const value = 1;");
    const mixed = await buildDependencyGraph({ repoPath: root });
    assert.ok(mixed.adapterBlockers?.some(reason => reason.includes("Mixed Rust")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("documentation stays full-suite when Rust code may read it, and excluded fixture crates are confined", async t => {
  const files: Record<string, string> = { "Cargo.toml": '[workspace]\nmembers=["core", "app"]\nexclude=["tests/fixtures"]\n', ".github/workflows/test.yml": workflow(),
    "tests/fixtures/sample/Cargo.toml": '[package]\nname="sample"\nversion="0.1.0"\n', "tests/fixtures/sample/src/lib.rs": "pub fn sample() {}" };
  for (const name of ["core", "app"]) {
    files[`${name}/Cargo.toml`] = `[package]\nname="${name}"\nversion="0.1.0"\n`;
    files[`${name}/src/lib.rs`] = "pub fn value() {}";
  }
  const root = fixture(files);
  const packages = ["core", "app"].map(name => ({ id: name, name, manifest_path: join(root, name, "Cargo.toml"), dependencies: [], features: {}, targets: [
    { name, kind: ["lib"], src_path: join(root, name, "src/lib.rs"), test: true, doctest: true },
  ] }));
  const metadata = (extra: object[] = []) => JSON.stringify({ packages: [...packages, ...extra], workspace_members: packages.map(p => p.id), workspace_default_members: packages.map(p => p.id),
    workspace_root: root, resolve: { nodes: [...packages, ...extra].map(p => ({ id: (p as { id: string }).id, dependencies: [] })) } });
  let output = metadata();
  t.mock.method(rustAdapter, "analyze", (context: AdapterContext) => analyzeRustMetadata(context, output));
  try {
    let graph = await buildDependencyGraph({ repoPath: root });
    // No member depends on the excluded fixture crate, so it no longer blocks the repository.
    assert.deepEqual(graph.adapterBlockers, []);
    assert.equal(new ImpactAnalyzer().analyze(delta("core/src/lib.rs"), graph, graph.profile).fallbackRequired, false);
    const fixtureChange = new ImpactAnalyzer().analyze(delta("tests/fixtures/sample/src/lib.rs"), graph, graph.profile);
    assert.equal(fixtureChange.fallbackRequired, true);
    assert.equal(new ImpactAnalyzer().analyze(delta("README.md"), graph, graph.profile).fallbackRequired, false);
    // A test that names README.md may read it at run time: documentation keeps the full suite.
    writeFileSync(join(root, "app/src/lib.rs"), '#[test] fn readme() { assert!(std::fs::read_to_string("../README.md").is_ok()); }');
    graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.profile.rustDocumentationReaders, ["app/src/lib.rs"]);
    assert.equal(new ImpactAnalyzer().analyze(delta("README.md"), graph, graph.profile).fallbackRequired, true);
    // A member that path-depends on the fixture keeps the repository-wide fallback.
    output = metadata([{ id: "sample", name: "sample", manifest_path: join(root, "tests/fixtures/sample/Cargo.toml"), dependencies: [], features: {},
      targets: [{ name: "sample", kind: ["lib"], src_path: join(root, "tests/fixtures/sample/src/lib.rs"), test: true, doctest: true }] }]);
    graph = await buildDependencyGraph({ repoPath: root });
    assert.ok(graph.adapterBlockers?.some(reason => reason.startsWith("Cargo manifests outside workspace membership")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
