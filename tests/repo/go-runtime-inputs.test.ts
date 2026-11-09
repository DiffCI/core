import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { GraphCache, buildGraphCacheKey } from "../../src/cache/graph-cache.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";
import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import { analyzeGoMetadata, goAdapter } from "../../src/repo/adapters/go.js";
import { analyzePythonRepository, pythonAdapter, type PythonFileImports } from "../../src/repo/adapters/python.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import { buildDependencyGraph, hydrateDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { DependencyGraphResult } from "../../src/repo/types.js";

const allTests = ["p/value_test.go", "service/service_test.go", "unrelated/value_test.go"];
const ownerTests = ["p/value_test.go", "service/service_test.go"];

function delta(file: ChangedFile): GitDelta {
  return {
    baseSha: "base", headSha: "head", files: [file], directories: [],
    summary: { total: 1, added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, [file.changeType]: 1 },
    analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
  };
}

function planChange(graph: DependencyGraphResult, file: ChangedFile, analysis?: { repoPath: string; fileContents?: Record<string, string> }) {
  const change = delta(file);
  // Content checks need the same wiring the engine uses (src/analyze.ts): the repository reader and the
  // file inventory. Tests that only assert fallback behavior can omit them and fail closed instead.
  const analysisOptions = analysis ? { repositoryFiles: new Set(Object.keys(analysis.fileContents ?? {})), readRepositoryFile: repositoryFileReader(analysis.repoPath) } : undefined;
  const impact = analysisOptions
    ? new ImpactAnalyzer().analyze(change, graph, graph.profile, analysisOptions)
    : new ImpactAnalyzer().analyze(change, graph, graph.profile);
  const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta: change, impact, profile: graph.profile });
  return { impact, plan };
}

// Exercise real graph construction, impact, and command planning with valid synthetic go list
// descriptors. This suite does not need a Go installation and does not execute Go repository code.
async function fixture(
  extraFiles: Record<string, string>,
  run: (graph: DependencyGraphResult, root: string, files: Record<string, string>) => void | Promise<void>,
  embeds: { production?: string[]; test?: string[]; external?: string[] } = {},
  extraServiceTestName?: string,
  pythonImports?: Record<string, PythonFileImports>,
) {
  const root = mkdtempSync(join(tmpdir(), "diffci-go-runtime-inputs-"));
  const declarations = (paths: string[] = []) => paths.map((path, index) => `//go:embed ${path}\nvar embedded${index} string\n`).join("");
  const files = {
    "go.mod": "module example.com/project\n\ngo 1.24\n",
    "p/value.go": `package p\nimport "os"\n${embeds.production?.length ? 'import _ "embed"\n' : ""}${declarations(embeds.production)}func Read(name string) ([]byte, error) { return os.ReadFile(name) }\n`,
    "p/value_test.go": `package p\nimport "testing"\n${embeds.test?.length ? 'import _ "embed"\n' : ""}${declarations(embeds.test)}func TestRead(t *testing.T) { data, err := Read("data/settings.json"); if err != nil || string(data) != "expected" { t.Fatal("bad runtime input") } }\n`,
    "p/data/settings.json": "expected",
    "service/service.go": 'package service\nimport "example.com/project/p"\nvar Read = p.Read\n',
    "service/service_test.go": 'package service\nimport "testing"\nfunc TestRead(t *testing.T) { if _, err := Read("../p/data/settings.json"); err != nil { t.Fatal(err) } }\n',
    "unrelated/value.go": "package unrelated\nconst Value = 2\n",
    "unrelated/value_test.go": 'package unrelated\nimport "testing"\nfunc TestValue(t *testing.T) { if Value != 2 { t.Fatal(Value) } }\n',
    ...(embeds.external?.length ? {
      "p/value_external_test.go": `package p_test\nimport _ "embed"\nimport "testing"\n${declarations(embeds.external)}func TestExternal(t *testing.T) {}\n`,
    } : {}),
    ...extraFiles,
  };
  const originalAnalyze = goAdapter.analyze;
  let originalPythonAnalyze: typeof pythonAdapter.analyze | undefined;
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const metadata = [
      { Dir: join(root, "p"), ImportPath: "example.com/project/p", Name: "p", GoFiles: ["value.go"], TestGoFiles: ["value_test.go"], Imports: ["os", ...(embeds.production?.length ? ["embed"] : [])], TestImports: ["testing", ...(embeds.test?.length ? ["embed"] : [])], EmbedFiles: embeds.production, TestEmbedFiles: embeds.test, XTestGoFiles: embeds.external?.length ? ["value_external_test.go"] : [], XTestImports: embeds.external?.length ? ["testing", "embed"] : [], XTestEmbedFiles: embeds.external },
      { Dir: join(root, "service"), ImportPath: "example.com/project/service", Name: "service", GoFiles: ["service.go"], TestGoFiles: extraServiceTestName ? ["service_test.go", extraServiceTestName] : ["service_test.go"], Imports: ["example.com/project/p"], TestImports: ["testing"] },
      { Dir: join(root, "unrelated"), ImportPath: "example.com/project/unrelated", Name: "unrelated", GoFiles: ["value.go"], TestGoFiles: ["value_test.go"], TestImports: ["testing"] },
      // A helper package reported without test files is still a reported package: mirrors whatever
      // testutil sources the fixture carries (currently golden.go importing "os").
      ...(Object.keys(files).some(path => /^testutil\/.+\.go$/.test(path) && !path.endsWith("_test.go")) ? [{
        Dir: join(root, "testutil"), ImportPath: "example.com/project/testutil", Name: "testutil", GoFiles: Object.keys(files).filter(path => /^testutil\/.+\.go$/.test(path) && !path.endsWith("_test.go")).map(path => path.slice("testutil/".length)), TestGoFiles: [], Imports: ["os"], TestImports: [],
      }] : []),
    ].map(pkg => JSON.stringify(pkg)).join("\n");
    goAdapter.analyze = context => {
      // Mirror the real adapter's nested-module scoping (root-module scope excludes the nested
      // roots from the metadata analysis and records them on the profile).
      if (context.profile.diffciConfig?.go?.scope === "root-module") {
        const nestedRoots = context.files.filter((file: string) => file.endsWith("/go.mod")).map((file: string) => file.slice(0, -"/go.mod".length));
        context.profile.goExcludedModuleRoots = nestedRoots;
        const scopedFiles = context.files.filter((file: string) => !nestedRoots.some(root => file.startsWith(root)));
        return analyzeGoMetadata({ ...context, files: scopedFiles }, metadata);
      }
      return analyzeGoMetadata(context, metadata);
    };
    // The python adapter is stubbed the same way: hand the resolver the file parses directly, so
    // the mixed-repository fixtures need no interpreter and still exercise real adapter logic.
    if (pythonImports) {
      originalPythonAnalyze = pythonAdapter.analyze;
      pythonAdapter.analyze = context => analyzePythonRepository(context, listed => Object.fromEntries(listed.map(file => [file, pythonImports[file] ?? { imports: [] }])));
    }
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    assert.equal(graph.confidence, "COMPLETE");
    await run(graph, root, files);
  } finally {
    goAdapter.analyze = originalAnalyze;
    if (originalPythonAnalyze) pythonAdapter.analyze = originalPythonAnalyze;
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFullRuntimeFallback(graph: DependencyGraphResult, file: ChangedFile, unmodeledPath = file.path, allTestPaths = allTests, analysis?: { repoPath: string; fileContents?: Record<string, string> }) {
  const { impact, plan } = planChange(graph, file, analysis);
  assert.equal(impact.fallbackRequired, true);
  assert.ok(impact.fallbackReasons.some(reason => reason.includes("Go runtime inputs outside source/embed metadata") && reason.includes(unmodeledPath)), impact.fallbackReasons.join("\n"));
  assert.equal(plan.mode, "FULL");
  assert.deepEqual([...plan.selectedTests].sort(), [...allTestPaths].sort());
  assert.deepEqual(plan.skippedTests, []);
  assert.deepEqual(plan.commandSpecs, []);
  assert.equal(plan.commandSynthesis?.status, "NOT_APPLICABLE");
}

test("Go os.ReadFile input outside testdata cannot produce an empty selective plan", async () => {
  await fixture({}, graph => {
    assert.equal(graph.graph.nodes.some(node => node.path === "p/data/settings.json"), false);
    assertFullRuntimeFallback(graph, { path: "p/data/settings.json", changeType: "modified" });
  });
});

test("Go unmodeled input fallback does not depend on extension or directory", async t => {
  const paths = [
    "p/data/config.jsonc", "p/data/theme.css", "p/data/icon.svg", "p/data/image.png", "p/data/font.woff2",
    "p/data/readme.md", "p/data/notes.txt", "p/data/config.yaml", "p/data/config.xml", "p/data/module.wasm",
    "p/data/CONFIG", "p/data/fixture.bin", "p/data/view.tmpl", "p/data/settings.JSON", "shared/settings.json",
    "README.md", "docs/guide.mdx", "docs/fixture.dat", "build/settings.json", "dist/settings.json", "vendor/data.json",
  ];
  await fixture(Object.fromEntries(paths.map(path => [path, "runtime data"])), async graph => {
    for (const path of paths) await t.test(path, () => assertFullRuntimeFallback(graph, { path, changeType: "modified" }));
  });
});

for (const changeType of ["added", "deleted", "renamed", "copied"] as const) {
  test(`Go unmodeled ${changeType} runtime input requires full validation`, async () => {
    const path = "p/data/new.json";
    await fixture(changeType === "deleted" ? {} : { [path]: "changed" }, graph => {
      assertFullRuntimeFallback(graph, { path, changeType, ...(["renamed", "copied"].includes(changeType) ? { oldPath: "p/data/old.json" } : {}) });
    });
  });
}

test("Go rename origin stays unsafe when the destination is a modeled embed", async () => {
  await fixture({ "p/data/new.json": "changed" }, graph => {
    assertFullRuntimeFallback(graph, { path: "p/data/new.json", oldPath: "p/data/old.json", changeType: "renamed" }, "p/data/old.json");
  }, { production: ["data/new.json"] });
});

test("a generic graph node does not prove Go runtime-input ownership", async () => {
  await fixture({}, (graph, root) => {
    for (const path of ["shared/settings.json", "other/value.java", "other/data.go"]) {
      graph.graph = hydrateDependencyGraph({
        ...graph.graph,
        nodes: [...graph.graph.nodes, { path, isSource: path.endsWith(".go") || path.endsWith(".java"), isAsset: path.endsWith(".json"), isTest: false, isEntryPoint: false }],
        edges: [...graph.graph.edges, { from: "unrelated/value.go", to: path, kind: "asset" }],
      }, root);
      assertFullRuntimeFallback(graph, { path, changeType: "modified" });
    }
  });
});

test("Go source-only changes remain selective despite unchanged unmodeled inputs", async () => {
  await fixture({}, graph => {
    const { impact, plan } = planChange(graph, { path: "p/value.go", changeType: "modified" });
    assert.equal(impact.fallbackRequired, false);
    assert.deepEqual(plan.selectedTests, ownerTests);
    assert.deepEqual(plan.skippedTests, ["unrelated/value_test.go"]);
    assert.equal(plan.mode, "SELECTIVE");
    assert.equal(plan.commandSynthesis?.status, "OK");
    assert.deepEqual(plan.commandSpecs[0]?.args, ["test", "-mod=readonly", "-json", "-count=1", "./p", "./service"]);
  });
});

for (const field of ["production", "test", "external"] as const) {
  test(`Go ${field} embeds retain package and transitive test selection`, async () => {
    await fixture({ "p/data/embedded.json": "embedded" }, graph => {
      const { impact, plan } = planChange(graph, { path: "p/data/embedded.json", changeType: "modified" });
      assert.equal(impact.fallbackRequired, false);
      assert.equal(plan.mode, "SELECTIVE");
      assert.deepEqual(plan.selectedTests, field === "external" ? ["p/value_external_test.go", ...ownerTests] : ownerTests);
      assert.deepEqual(plan.skippedTests, ["unrelated/value_test.go"]);
      assert.equal(plan.commandSynthesis?.status, "OK");
    }, { [field]: ["data/embedded.json"] });
  });
}

test("Go modeled embeds traverse ownership regardless of extension or docs classification", async t => {
  const paths = ["data/config.yaml", "data/CONFIG", "data/fixture.bin", "docs/guide.mdx"];
  await fixture(Object.fromEntries(paths.map(path => [`p/${path}`, "embedded"])), async graph => {
    for (const path of paths) await t.test(path, () => {
      const { impact, plan } = planChange(graph, { path: `p/${path}`, changeType: "modified" });
      assert.equal(impact.fallbackRequired, false);
      assert.equal(plan.mode, "SELECTIVE");
      assert.deepEqual(plan.selectedTests, ownerTests);
      assert.deepEqual(plan.skippedTests, ["unrelated/value_test.go"]);
      assert.equal(plan.commandSynthesis?.status, "OK");
    });
  }, { production: paths });
});

test("Go testdata, hidden and underscore paths retain full validation even when embedded", async () => {
  const paths = ["testdata/settings.json", ".data/settings.json", "_data/settings.json"];
  await fixture(Object.fromEntries(paths.map(path => [`p/${path}`, "embedded"])), graph => {
    for (const path of paths) {
      const { impact, plan } = planChange(graph, { path: `p/${path}`, changeType: "modified" });
      assert.equal(impact.fallbackRequired, true);
      assert.ok(impact.fallbackReasons.some(reason => reason.includes("Go discovery-excluded paths")));
      assert.equal(plan.mode, "FULL");
      assert.deepEqual(plan.selectedTests, allTests);
    }
  }, { production: paths });
});

test("embedded package testdata keeps full validation also with repository contents available", async () => {
  const files = { "p/testdata/settings.json": "embedded" };
  await fixture(files, (graph, root) => {
    // The engine wires repository contents (src/analyze.ts); this is the production wiring, not
    // the fail-closed absence of it, and the embed still keeps its discovery-excluded fallback.
    const analysis = { repoPath: root, fileContents: files };
    const { impact, plan } = planChange(graph, { path: "p/testdata/settings.json", changeType: "modified" }, analysis);
    assert.equal(impact.fallbackRequired, true);
    assert.ok(impact.fallbackReasons.some(reason => reason.includes("Go discovery-excluded paths")), impact.fallbackReasons.join("\n"));
    // the embed is modeled, so the "runtime inputs outside source/embed metadata" message never names it
    assert.ok(impact.fallbackReasons.every(reason => !reason.includes("runtime inputs outside source/embed metadata")), impact.fallbackReasons.join("\n"));
    assert.equal(plan.mode, "FULL");
    assert.deepEqual([...plan.selectedTests].sort(), [...allTests].sort());
    assert.ok(!impact.affectedTests.some(t => t.reasons.includes("GO_TESTDATA")));
  }, { production: ["testdata/settings.json"] });
});

test("Go modeled-path evidence survives graph caching", async () => {
  await fixture({ "p/data/embedded.json": "embedded" }, (graph, root) => {
    const cache = new GraphCache({ cacheDir: join(root, ".cache") });
    const key = buildGraphCacheKey({ commitSha: "head" });
    cache.save(key, graph);
    const loaded = cache.load(key)!;
    assert.ok(loaded);
    loaded.graph = hydrateDependencyGraph(loaded.graph, root);
    const { plan } = planChange(loaded, { path: "p/data/embedded.json", changeType: "modified" });
    assert.equal(plan.mode, "SELECTIVE");
    assert.deepEqual(plan.selectedTests, ownerTests);
    assertFullRuntimeFallback(loaded, { path: "p/data/settings.json", changeType: "modified" });

  }, { production: ["data/embedded.json"] });
});

test("Go legacy cached profiles without modeled-path evidence fail closed", async () => {
  await fixture({ "p/data/embedded.json": "embedded" }, (graph, root) => {
    delete graph.profile.goDependencyPaths;
    const cache = new GraphCache({ cacheDir: join(root, ".cache") });
    const key = buildGraphCacheKey({ commitSha: "head" });
    cache.save(key, graph);
    const loaded = cache.load(key)!;
    assert.ok(loaded);
    loaded.graph = hydrateDependencyGraph(loaded.graph, root);
    assertFullRuntimeFallback(loaded, { path: "p/data/embedded.json", changeType: "modified" });
    assertFullRuntimeFallback(loaded, { path: "p/value.go", changeType: "modified" });
  }, { production: ["data/embedded.json"] });
});

// -- Go package testdata (issue 83): `testdata/` of a package with tests selects those tests -------------
test("a changed package testdata input selects the owning package's tests", async () => {
  const files = { "p/testdata/settings.json": "expected" };
  await fixture(files, (graph, root) => {
    const { impact, plan } = planChange(graph, { path: "p/testdata/settings.json", changeType: "modified" }, { repoPath: root, fileContents: files });
    assert.equal(impact.fallbackRequired, false);
    assert.equal(plan.mode, "SELECTIVE");
    assert.deepEqual(plan.selectedTests, ["p/value_test.go"]);
    assert.deepEqual(plan.skippedTests, ["service/service_test.go", "unrelated/value_test.go"]);
    assert.ok(impact.affectedTests.some(t => t.reasons.includes("GO_TESTDATA")), impact.affectedTests.map(t => t.reasons.join("|")).join("\n"));
    assert.ok(impact.evidence.some(e => e.reason === "GO_TESTDATA" && e.message.includes("p/testdata/settings.json")));
  });
});

test("a sibling package's test file naming the testdata keeps full validation", async () => {
  const files = {
    "p/testdata/settings.json": "expected",
    // package service's sibling test names ../p/testdata, so p's testdata is not package-private
    "service/service_relative_test.go": 'package service\nimport "testing"\nfunc TestRelative(t *testing.T) { _ = "../p/testdata/settings.json" }',
  };
  await fixture(files, (graph, root) => {
    const relative = [...allTests, "service/service_relative_test.go"];
    assertFullRuntimeFallback(graph, { path: "p/testdata/settings.json", changeType: "modified" }, "p/testdata/settings.json", relative, { repoPath: root, fileContents: files });
    const { impact, plan } = planChange(graph, { path: "p/testdata/settings.json", changeType: "modified" }, { repoPath: root, fileContents: files });
    assert.ok(impact.fallbackReasons.some(reason => reason.includes("Go discovery-excluded paths")), impact.fallbackReasons.join("\n"));
    assert.equal(plan.mode, "FULL");
  }, {}, "service_relative_test.go");
});

test("sibling test files naming only the testdata directory also fall back", async () => {
  const files = {
    "p/testdata/settings.json": "expected",
    // written the way the issue describes it: `"../p/testdata"` without the file name
    "service/service_relative_test.go": 'package service\nimport "testing"\nfunc TestRelative(t *testing.T) { _ = "../p/testdata" }',
  };
  await fixture(files, (graph, root) => {
    const relative = [...allTests, "service/service_relative_test.go"];
    assertFullRuntimeFallback(graph, { path: "p/testdata/settings.json", changeType: "modified" }, "p/testdata/settings.json", relative, { repoPath: root, fileContents: files });
  }, {}, "service_relative_test.go");
});

test("testdata below an owning package without tests, and *_/.-named directories, fall back", async t => {
  const paths = ["orphan/testdata/case.json", "_scratch/p/testdata/case.json", "p/testdata/_hidden/case.json"];
  await fixture(Object.fromEntries(paths.map(path => [path, "data"])), async graph => {
    for (const path of paths) await t.test(path, () => {
      const { impact, plan } = planChange(graph, { path, changeType: "modified" });
      assert.equal(impact.fallbackRequired, true);
      assert.ok(impact.fallbackReasons.some(reason => reason.includes("Go runtime inputs outside source/embed metadata") && reason.includes(path)), impact.fallbackReasons.join("\n"));
      assert.ok(impact.fallbackReasons.some(reason => reason.includes("Go discovery-excluded paths")));
      assert.equal(plan.mode, "FULL");
      assert.deepEqual(plan.selectedTests, allTests);
    });
  });
});

test("a legacy cached profile without test-package evidence fails closed for testdata", async () => {
  await fixture({ "p/testdata/settings.json": "expected" }, (graph, root) => {
    delete graph.profile.goTestPackages;
    const cache = new GraphCache({ cacheDir: join(root, ".cache") });
    const key = buildGraphCacheKey({ commitSha: "head" });
    cache.save(key, graph);
    const loaded = cache.load(key)!;
    assert.ok(loaded);
    loaded.graph = hydrateDependencyGraph(loaded.graph, root);
    assertFullRuntimeFallback(loaded, { path: "p/testdata/settings.json", changeType: "modified" });
  });
});

test("declared inputs add their tests to the package-owned testdata selection", async () => {
  const files = { "p/testdata/settings.json": "expected" };
  await fixture(files, (graph, root) => {
    graph.profile.diffciConfig = { inputs: [{ files: ["p/testdata/**"], tests: ["service/**"] }] };
    const { impact, plan } = planChange(graph, { path: "p/testdata/settings.json", changeType: "modified" }, { repoPath: root, fileContents: files });
    assert.equal(impact.fallbackRequired, false);
    assert.equal(plan.mode, "SELECTIVE");
    // the declaration's tests and the owning package's tests union into one selection
    assert.deepEqual([...plan.selectedTests].sort(), ["p/value_test.go", "service/service_test.go"]);
    assert.ok(impact.affectedTests.some(t => t.path === "service/service_test.go" && t.reasons.includes("DECLARED_INPUT")));
    assert.ok(impact.affectedTests.some(t => t.path === "p/value_test.go" && t.reasons.includes("GO_TESTDATA")));
  });
});

test("non-test Go helper naming testdata", async () => {
  // A shared helper in an ordinary `.go` file (the testutil/golden.go pattern) reads another
  // package's testdata on behalf of its callers' tests; the cross-package check must scan
  // ordinary sources, not only `_test.go` files (2026-11-09 review of #85).
  const files = {
    "p/testdata/settings.json": "expected",
    "service/service.go": 'package service\nimport "os"\nfunc Read(name string) ([]byte, error) { return os.ReadFile("../p/testdata/settings.json") }\n',
  };
  await fixture(files, (graph, root, files) => {
    assertFullRuntimeFallback(graph, { path: "p/testdata/settings.json", changeType: "modified" }, "p/testdata/settings.json", allTests, { repoPath: root, fileContents: files });
  });
});

test("a test outside every go-reported package naming the testdata keeps full validation", async () => {
  // A test in a nested module (excluded from go list package discovery) reads the testdata
  // directly; it runs with its own working directory, so the package-owned convention cannot
  // hold and the reference must unlock full validation (2026-11-09 review of #85).
  const files = {
    "diffci.json": '{\n  "go": { "scope": "root-module" }\n}\n',
    "legacy/go.mod": "module example.com/legacy\n\ngo 1.24\n",
    "legacy/tools/manual_test.go": 'package tools\nimport "os"\nimport "testing"\nfunc TestManual(t *testing.T) { if data, err := os.ReadFile("../../p/testdata/settings.json"); err != nil || string(data) != "expected" { t.Fatal("bad runtime input") } }\n',
  };
  await fixture(files, (graph, root, files) => {
    assertFullRuntimeFallback(graph, { path: "p/testdata/settings.json", changeType: "modified" }, "p/testdata/settings.json", allTests, { repoPath: root, fileContents: files });
  });
});

test("a helper package without tests of its own naming testdata keeps full validation", async () => {
  // The usual testutil/golden.go shape: a helper package with no tests of its own reads another
  // package's testdata for the callers' tests (service imports testutil below and its test calls
  // Golden). A cross-package scan over packages with tests alone never reaches that package,
  // since it contributes no `_test.go` file of its own (2026-11-09 review of #85).
  const files = {
    "p/testdata/settings.json": "expected",
    "testutil/golden.go": 'package testutil\nimport "os"\nfunc Golden() ([]byte, error) { return os.ReadFile("../p/testdata/settings.json") }\n',
    "service/service_test.go": 'package service\nimport "testing"\nimport "example.com/project/testutil"\nfunc TestGolden(t *testing.T) { if _, err := testutil.Golden(); err != nil { t.Fatal(err) } }\n',
  };
  await fixture(files, (graph, root, files) => {
    assertFullRuntimeFallback(graph, { path: "p/testdata/settings.json", changeType: "modified" }, "p/testdata/settings.json", allTests, { repoPath: root, fileContents: files });
  });
});

test("a python helper in a modeled mixed repository naming testdata keeps full validation", async () => {
  // In a mixed (go + python) repository a non-test helper reads a package's testdata for the test
  // that imports it; the outside-readers pool only took `.go` files and test-matched files, so the
  // helper's reference was never checked (2026-11-09 review of #85). A Go adapter plus any
  // JavaScript file is itself a mixed-repo blocker, so the JS variant cannot reach a healthy graph.
  const files = {
    "p/testdata/settings.json": "expected",
    "pyproject.toml": '[project]\nname = "mixed"\n',
    "tools/snapshot.py": 'from pathlib import Path\n\ndef snapshot() -> str:\n    return Path("../p/testdata/settings.json").read_text()\n',
    "tools/test_snapshot.py": 'from .snapshot import snapshot\n\ndef test_snapshot():\n    assert snapshot() == "expected"\n',
  };
  await fixture(files, (graph, root, files) => {
    assertFullRuntimeFallback(graph, { path: "p/testdata/settings.json", changeType: "modified" }, "p/testdata/settings.json", [...allTests, "tools/test_snapshot.py"], { repoPath: root, fileContents: files });
  }, {}, undefined, {
    "tools/snapshot.py": { imports: [] },
    "tools/test_snapshot.py": { imports: [[".snapshot", 1, ["snapshot"]]] },
  });
});
