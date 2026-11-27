// SPDX-License-Identifier: MIT
/** pnpm-lock.yaml attribution: snapshot closures, peer contexts, workspace importers and fail-closed cases. */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { pnpmLockAffectedDependencies, pnpmLockImporters, pnpmWorkspaceLockImpact } from "../../src/repo/pnpm-lockfile.js";

type Versions = Record<string, string>;
const integrity = (key: string) => ({ resolution: { integrity: `sha512-${key}` } });

/** A format 9.0 lockfile: `a -> shared`, `b`, and `c` with a resolved peer on `b`. */
function lock(versions: Versions = {}, extra: Record<string, unknown> = {}): string {
  const v = { a: "1.0.0", b: "1.0.0", c: "1.0.0", shared: "1.0.0", ...versions };
  const c = `c@${v.c}(b@${v.b})`;
  return stringify({
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { ".": { dependencies: {
      a: { specifier: "^1.0.0", version: v.a },
      b: { specifier: "^1.0.0", version: v.b },
      c: { specifier: "^1.0.0", version: `${v.c}(b@${v.b})` },
    } } },
    packages: {
      [`a@${v.a}`]: integrity(`a${v.a}`),
      [`b@${v.b}`]: integrity(`b${v.b}`),
      [`c@${v.c}`]: { ...integrity(`c${v.c}`), peerDependencies: { b: "^1" } },
      [`shared@${v.shared}`]: integrity(`shared${v.shared}`),
    },
    snapshots: {
      [`a@${v.a}`]: { dependencies: { shared: v.shared } },
      [`b@${v.b}`]: {},
      [c]: { dependencies: { b: v.b } },
      [`shared@${v.shared}`]: {},
    },
    ...extra,
  });
}

describe("pnpmLockAffectedDependencies", () => {
  const direct = ["a", "b", "c"];
  it("attributes a direct bump, and a peer bump to the package resolved against it", () => {
    assert.deepEqual(pnpmLockAffectedDependencies(lock(), lock({ b: "1.1.0" }), direct), ["b", "c"]);
  });
  it("attributes a transitive bump to every direct dependency that reaches it", () => {
    assert.deepEqual(pnpmLockAffectedDependencies(lock(), lock({ shared: "1.0.1" }), direct), ["a"]);
  });
  it("attributes a changed resolution with the same version", () => {
    const after = lock().replace("sha512-shared1.0.0", "sha512-republished");
    assert.deepEqual(pnpmLockAffectedDependencies(lock(), after, direct), ["a"]);
  });
  it("follows alias edges to the real package", () => {
    const aliased = lock().replace("shared: 1.0.0\n", "shared: shared@1.0.0\n");
    assert.deepEqual(pnpmLockAffectedDependencies(aliased, aliased.replaceAll("shared@1.0.0", "shared@1.0.1").replace("sha512-shared1.0.0", "sha512-shared1.0.1"), direct), ["a"]);
  });
  it("reports nothing for a semantic no-op", () => {
    assert.deepEqual(pnpmLockAffectedDependencies(lock(), lock() + "\n", direct), []);
  });
  it("returns undefined for what it does not model", () => {
    const cases: [string, string][] = [
      ["settings change", lock({}, { settings: { autoInstallPeers: false, excludeLinksFromLockfile: false } })],
      ["overrides", lock({}, { overrides: { shared: "1.0.0" } })],
      ["patched dependency", lock({}, { patchedDependencies: { shared: { hash: "x", path: "patches/shared.patch" } } })],
    ];
    for (const [name, after] of cases) assert.equal(pnpmLockAffectedDependencies(lock(), after, direct), undefined, name);
    const orphan = lock().replace("snapshots:\n", "snapshots:\n  orphan@1.0.0: {}\n").replace("packages:\n", "packages:\n  orphan@1.0.0:\n    resolution:\n      integrity: sha512-orphan\n");
    assert.equal(pnpmLockAffectedDependencies(lock(), orphan, direct), undefined, "orphan package");
    const workspace = lock().replace('importers:\n  ".":', 'importers:\n  packages/web: {}\n  ".":').replace("importers:\n  .:", "importers:\n  packages/web: {}\n  .:");
    assert.equal(pnpmLockAffectedDependencies(lock(), workspace, direct), undefined, "workspace importer");
    const linked = lock().replace("version: 1.0.0\n", "version: link:../a\n");
    assert.equal(pnpmLockAffectedDependencies(lock(), linked, direct), undefined, "link: dependency");
    const dangling = lock().replace("shared: 1.0.0\n", "shared: 9.9.9\n");
    assert.equal(pnpmLockAffectedDependencies(lock(), dangling, direct), undefined, "dangling edge");
    assert.equal(pnpmLockAffectedDependencies(lock().replace("lockfileVersion: \"9.0\"", "lockfileVersion: \"6.0\""), lock(), direct), undefined, "format 6.0");
    assert.equal(pnpmLockAffectedDependencies("importers: [", lock(), direct), undefined, "unparseable");
    assert.equal(pnpmLockAffectedDependencies(undefined, lock(), direct), undefined, "missing");
  });
});

describe("pnpm dependency bumps end to end", () => {
  function write(dir: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  }
  const manifest = (a = "^1.0.0", fields: Record<string, unknown> = {}) => JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" },
    dependencies: { a, b: "^1.0.0", c: "^1.0.0" }, ...fields }, null, 2);
  const files = {
    "package.json": manifest(),
    "pnpm-lock.yaml": lock(),
    "src/uses-a.js": `import a from "a";\nexport const value = a;\n`,
    "src/uses-a.test.js": `import { value } from "./uses-a.js";\nimport test from "node:test";\ntest("a", () => value);\n`,
    "src/uses-b.test.js": `import b from "b";\nimport test from "node:test";\ntest("b", () => b);\n`,
    "src/uses-c.test.js": `import c from "c";\nimport test from "node:test";\ntest("c", () => c);\n`,
    // package.json is still resolved by reference, as for npm: whoever reads it is selected too.
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
  async function inRepo(extra: Record<string, string>, body: (dir: string) => Promise<void>) {
    const dir = join(tmpdir(), `diffci-pnpm-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
      write(dir, { ...files, ...extra });
      execSync("git add -A && git commit --quiet -m base", { cwd: dir });
      await body(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it("selects the tests that import the bumped package and its peer dependents", async () => {
    await inRepo({}, async (dir) => {
      const peer = await analyze(dir, { "pnpm-lock.yaml": lock({ b: "1.1.0" }) });
      assert.deepEqual(peer.delta.analysis.changedDependencies, ["b", "c"]);
      assert.equal(peer.delta.analysis.dependencyLockfile, "pnpm-lock.yaml");
      assert.deepEqual(peer.impact.fallbackReasons, []);
      assert.deepEqual(peer.impact.affectedTests.map((t) => t.path), ["src/uses-b.test.js", "src/uses-c.test.js"]);
      const bump = await analyze(dir, { "package.json": manifest("^1.1.0"), "pnpm-lock.yaml": lock({ b: "1.1.0", a: "1.1.0" }).replace("specifier: ^1.0.0\n      version: 1.1.0", "specifier: ^1.1.0\n      version: 1.1.0") });
      assert.deepEqual(bump.delta.analysis.changedDependencies, ["a"]);
      assert.deepEqual(bump.impact.fallbackReasons, []);
      assert.deepEqual(bump.impact.affectedTests.map((t) => t.path), ["src/uses-a.test.js", "tests/manifest.test.js"]);
    });
  });

  it("needs no package.json reader for a request-only bump, but still does for a moved dependency", async () => {
    const bumpA = { "package.json": manifest("^1.1.0"), "pnpm-lock.yaml": lock({ a: "1.1.0" }).replace("specifier: ^1.0.0\n      version: 1.1.0", "specifier: ^1.1.0\n      version: 1.1.0") };
    await inRepo({ "tests/manifest.test.js": `import test from "node:test";\ntest("m", () => {});\n` }, async (dir) => {
      const bump = await analyze(dir, bumpA);
      assert.equal(bump.delta.analysis.packageJsonSpecifiersOnly, true);
      assert.deepEqual(bump.impact.fallbackReasons, []);
      assert.deepEqual(bump.impact.affectedTests.map((t) => t.path), ["src/uses-a.test.js"]);
      const moved = parse(lock({ a: "1.1.0" })) as { importers: Record<string, Record<string, Record<string, unknown>>> };
      const root = moved.importers["."]!;
      root.devDependencies = { c: root.dependencies!.c };
      delete root.dependencies!.c;
      const { c, ...rest } = JSON.parse(manifest("^1.1.0")).dependencies;
      const move = await analyze(dir, { "package.json": manifest("^1.1.0", { dependencies: rest, devDependencies: { c } }), "pnpm-lock.yaml": stringify(moved) });
      assert.equal(move.delta.analysis.packageJsonSpecifiersOnly, undefined);
      assert.deepEqual(move.impact.fallbackReasons, ["Unknown changed file: package.json"]);
    });
    await inRepo({
      "tests/manifest.test.js": `import test from "node:test";\ntest("m", () => {});\n`,
      "vitest.config.js": 'import { readFileSync } from "node:fs";\nexport default { value: readFileSync("package.json", "utf8") };\n',
    }, async (dir) => {
      const tooling = await analyze(dir, bumpA);
      assert.equal(tooling.delta.analysis.packageJsonSpecifiersOnly, true);
      assert.deepEqual(tooling.impact.fallbackReasons, ["Unknown changed file: package.json"]);
    });
  });

  it("keeps the full suite for an unmatched manifest edit, pnpm configuration and undeclared imports", async () => {
    await inRepo({}, async (dir) => {
      const unlocked = await analyze(dir, { "package.json": manifest("^1.2.0") });
      assert.ok(unlocked.impact.fallbackReasons.some((reason) => reason.startsWith("Dependency manifest changed")));
      const npmrc = await analyze(dir, { ".npmrc": "node-linker=hoisted\n", "pnpm-lock.yaml": lock({ shared: "1.0.1" }) });
      assert.equal(npmrc.delta.analysis.changedDependencies, undefined);
      assert.ok(npmrc.impact.fallbackReasons.length > 0);
    });
    await inRepo({ "src/uses-shared.test.js": `import shared from "shared";\nimport test from "node:test";\ntest("s", () => shared);\n` }, async (dir) => {
      const hoisted = await analyze(dir, { "pnpm-lock.yaml": lock({ shared: "1.0.1" }) });
      assert.deepEqual(hoisted.delta.analysis.changedDependencies, ["a"]);
      assert.deepEqual(hoisted.impact.fallbackReasons, ["pnpm lockfile changed and repository imports undeclared dependencies (shared); full validation required"]);
    });
  });

  it("resolves tests that read the lockfile itself", async () => {
    await inRepo({ "tests/lock.test.js": `import { readFileSync } from "node:fs";\nimport test from "node:test";\ntest("l", () => readFileSync("pnpm-lock.yaml", "utf8"));\n` }, async (dir) => {
      const noop = await analyze(dir, { "pnpm-lock.yaml": lock() + "\n# regenerated\n" });
      assert.deepEqual(noop.delta.analysis.changedDependencies, []);
      assert.deepEqual(noop.impact.fallbackReasons, []);
      assert.deepEqual(noop.impact.affectedTests.map((t) => t.path), ["tests/lock.test.js"]);
    });
  });
});

/**
 * A workspace lockfile: the root requests `tool`, `packages/web` requests `a` (which reaches
 * `shared`) and links `@fx/lib`, and `packages/lib` requests `b`.
 */
function workspaceLock(versions: Versions = {}, edit: (importers: Record<string, Record<string, Record<string, unknown>>>) => void = () => {}): string {
  const v = { a: "1.0.0", b: "1.0.0", shared: "1.0.0", tool: "1.0.0", ...versions };
  const importers: Record<string, Record<string, Record<string, unknown>>> = {
    ".": { devDependencies: { tool: { specifier: "^1.0.0", version: v.tool } } },
    "packages/lib": { dependencies: { b: { specifier: "^1.0.0", version: v.b } } },
    "packages/web": { dependencies: {
      "@fx/lib": { specifier: "workspace:*", version: "link:../lib" },
      a: { specifier: "^1.0.0", version: v.a },
    } },
  };
  edit(importers);
  return stringify({
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers,
    packages: {
      [`a@${v.a}`]: integrity(`a${v.a}`),
      [`b@${v.b}`]: integrity(`b${v.b}`),
      [`shared@${v.shared}`]: integrity(`shared${v.shared}`),
      [`tool@${v.tool}`]: integrity(`tool${v.tool}`),
    },
    snapshots: {
      [`a@${v.a}`]: { dependencies: { shared: v.shared } },
      [`b@${v.b}`]: {},
      [`shared@${v.shared}`]: {},
      [`tool@${v.tool}`]: {},
    },
  });
}

describe("pnpm workspace lockfiles", () => {
  const direct = { ".": ["tool"], "packages/lib": ["b"], "packages/web": ["@fx/lib", "a"] };
  it("lists the importers, and the single-project entry point still rejects them", () => {
    assert.deepEqual(pnpmLockImporters(workspaceLock()), [".", "packages/lib", "packages/web"]);
    assert.equal(pnpmLockAffectedDependencies(workspaceLock(), workspaceLock({ b: "1.1.0" }), ["tool"]), undefined);
  });
  it("attributes each importer's bumps, direct and transitive, and reports what each importer declares", () => {
    const lib = pnpmWorkspaceLockImpact(workspaceLock(), workspaceLock({ b: "1.1.0" }), direct);
    assert.deepEqual(lib?.dependencies, ["b"]);
    assert.deepEqual(lib?.declared, { ".": ["tool"], "packages/lib": ["b"], "packages/web": ["@fx/lib", "a"] });
    assert.deepEqual(pnpmWorkspaceLockImpact(workspaceLock(), workspaceLock({ shared: "1.0.1" }), direct)?.dependencies, ["a"]);
    assert.deepEqual(pnpmWorkspaceLockImpact(workspaceLock(), workspaceLock(), direct)?.dependencies, []);
  });
  it("returns undefined for what it does not model", () => {
    const cases: [string, string][] = [
      ["importer added", workspaceLock({}, (importers) => { importers["packages/new"] = {}; })],
      ["link retargeted", workspaceLock({}, (importers) => { importers["packages/web"]!.dependencies!["@fx/lib"] = { specifier: "workspace:*", version: "link:../web" }; })],
      ["link removed", workspaceLock({}, (importers) => { delete importers["packages/web"]!.dependencies!["@fx/lib"]; })],
      ["link outside the importers", workspaceLock({}, (importers) => { importers["packages/web"]!.dependencies!["@fx/lib"] = { specifier: "link:../../vendor", version: "link:../../vendor" }; })],
      ["file: reference", workspaceLock({}, (importers) => { importers["packages/lib"]!.dependencies!.b = { specifier: "file:../b", version: "file:../b" }; })],
      ["importer metadata", workspaceLock({}, (importers) => { importers["packages/lib"]!.dependenciesMeta = { b: { injected: true } }; })],
    ];
    for (const [name, after] of cases) assert.equal(pnpmWorkspaceLockImpact(workspaceLock(), after, direct), undefined, name);
    const escaping = workspaceLock().replace("packages/lib:", "../lib:");
    assert.equal(pnpmLockImporters(escaping), undefined, "importer outside the repository");
  });
});

describe("pnpm workspace dependency bumps end to end", () => {
  function write(dir: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  }
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const libManifest = (b = "^1.0.0", fields: Record<string, unknown> = {}) => json({ name: "@fx/lib", type: "module", dependencies: { b }, ...fields });
  const files = {
    "package.json": json({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" }, devDependencies: { tool: "^1.0.0" } }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": workspaceLock(),
    "packages/lib/package.json": libManifest(),
    "packages/lib/src/uses-b.js": `import b from "b";\nexport const value = b;\n`,
    "packages/lib/src/uses-b.test.js": `import { value } from "./uses-b.js";\nimport test from "node:test";\ntest("b", () => value);\n`,
    "packages/web/package.json": json({ name: "@fx/web", type: "module", dependencies: { "@fx/lib": "workspace:*", a: "^1.0.0" } }),
    "packages/web/src/uses-a.test.js": `import a from "a";\nimport test from "node:test";\ntest("a", () => a);\n`,
    "packages/web/src/plain.test.js": `import test from "node:test";\ntest("plain", () => {});\n`,
  };
  const bumpB = {
    "packages/lib/package.json": libManifest("^1.1.0"),
    "pnpm-lock.yaml": workspaceLock({ b: "1.1.0" }, (importers) => { importers["packages/lib"]!.dependencies!.b = { specifier: "^1.1.0", version: "1.1.0" }; }),
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
  async function inRepo(extra: Record<string, string>, body: (dir: string) => Promise<void>) {
    const dir = join(tmpdir(), `diffci-pnpm-ws-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
      write(dir, { ...files, ...extra });
      execSync("git add -A && git commit --quiet -m base", { cwd: dir });
      await body(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it("selects only the tests that import a package one workspace package bumped", async () => {
    await inRepo({}, async (dir) => {
      const bump = await analyze(dir, bumpB);
      assert.deepEqual(bump.delta.analysis.changedDependencies, ["b"]);
      assert.equal(bump.delta.analysis.dependencyLockfile, "pnpm-lock.yaml");
      assert.deepEqual(bump.impact.fallbackReasons, []);
      assert.deepEqual(bump.impact.affectedTests.map((t) => t.path), ["packages/lib/src/uses-b.test.js"]);
      const transitive = await analyze(dir, { "pnpm-lock.yaml": workspaceLock({ b: "1.1.0", shared: "1.0.1" }, (importers) => { importers["packages/lib"]!.dependencies!.b = { specifier: "^1.1.0", version: "1.1.0" }; }) });
      assert.deepEqual(transitive.delta.analysis.changedDependencies, ["a"]);
      assert.deepEqual(transitive.impact.fallbackReasons, []);
      assert.deepEqual(transitive.impact.affectedTests.map((t) => t.path), ["packages/web/src/uses-a.test.js"]);
    });
  });

  it("keeps the full suite for script edits, workspace scripts, undeclared imports and workspace configuration", async () => {
    await inRepo({}, async (dir) => {
      const scripted = await analyze(dir, { ...bumpB, "packages/lib/package.json": libManifest("^1.1.0", { scripts: { build: "tsc" } }) });
      assert.equal(scripted.delta.analysis.dependencyLockfile, undefined);
      assert.ok(scripted.impact.fallbackReasons.length > 0);
    });
    await inRepo({}, async (dir) => {
      const workspace = await analyze(dir, { ...bumpB, "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - tools/*\n" });
      assert.equal(workspace.delta.analysis.dependencyLockfile, undefined);
      assert.ok(workspace.impact.fallbackReasons.length > 0);
    });
    await inRepo({ "packages/lib/package.json": libManifest("^1.0.0", { scripts: { lint: "b --check" } }) }, async (dir) => {
      const runs = await analyze(dir, { ...bumpB, "packages/lib/package.json": libManifest("^1.1.0", { scripts: { lint: "b --check" } }) });
      assert.deepEqual(runs.delta.analysis.changedDependencies, ["b"]);
      assert.deepEqual(runs.impact.fallbackReasons, ["Dependency b changed and a workspace package script runs it; full validation required"]);
    });
    // `b` is declared by packages/lib only; packages/web resolving it relies on hoisting.
    await inRepo({ "packages/web/src/uses-b.test.js": `import b from "b";\nimport test from "node:test";\ntest("b", () => b);\n` }, async (dir) => {
      const hoisted = await analyze(dir, bumpB);
      assert.deepEqual(hoisted.impact.fallbackReasons, ["pnpm lockfile changed and repository imports undeclared dependencies (b); full validation required"]);
    });
  });
});
