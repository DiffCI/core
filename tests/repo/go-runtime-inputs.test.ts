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

function planChange(graph: DependencyGraphResult, file: ChangedFile) {
  const change = delta(file);
  const impact = new ImpactAnalyzer().analyze(change, graph, graph.profile);
  const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta: change, impact, profile: graph.profile });
  return { impact, plan };
}

// Exercise real graph construction, impact, and command planning with valid synthetic go list
// descriptors. This suite does not need a Go installation and does not execute Go repository code.
async function fixture(
  extraFiles: Record<string, string>,
  run: (graph: DependencyGraphResult, root: string) => void | Promise<void>,
  embeds: { production?: string[]; test?: string[]; external?: string[] } = {},
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
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const metadata = [
      { Dir: join(root, "p"), ImportPath: "example.com/project/p", Name: "p", GoFiles: ["value.go"], TestGoFiles: ["value_test.go"], Imports: ["os", ...(embeds.production?.length ? ["embed"] : [])], TestImports: ["testing", ...(embeds.test?.length ? ["embed"] : [])], EmbedFiles: embeds.production, TestEmbedFiles: embeds.test, XTestGoFiles: embeds.external?.length ? ["value_external_test.go"] : [], XTestImports: embeds.external?.length ? ["testing", "embed"] : [], XTestEmbedFiles: embeds.external },
      { Dir: join(root, "service"), ImportPath: "example.com/project/service", Name: "service", GoFiles: ["service.go"], TestGoFiles: ["service_test.go"], Imports: ["example.com/project/p"], TestImports: ["testing"] },
      { Dir: join(root, "unrelated"), ImportPath: "example.com/project/unrelated", Name: "unrelated", GoFiles: ["value.go"], TestGoFiles: ["value_test.go"], TestImports: ["testing"] },
    ].map(pkg => JSON.stringify(pkg)).join("\n");
    goAdapter.analyze = context => analyzeGoMetadata(context, metadata);
    const graph = await buildDependencyGraph({ repoPath: root });
    assert.deepEqual(graph.adapterBlockers, []);
    assert.equal(graph.confidence, "COMPLETE");
    await run(graph, root);
  } finally {
    goAdapter.analyze = originalAnalyze;
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFullRuntimeFallback(graph: DependencyGraphResult, file: ChangedFile, unmodeledPath = file.path) {
  const { impact, plan } = planChange(graph, file);
  assert.equal(impact.fallbackRequired, true);
  assert.ok(impact.fallbackReasons.some(reason => reason.includes("Go runtime inputs outside source/embed metadata") && reason.includes(unmodeledPath)), impact.fallbackReasons.join("\n"));
  assert.equal(plan.mode, "FULL");
  assert.deepEqual(plan.selectedTests, allTests);
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
