// SPDX-License-Identifier: MIT
// Export-level selection (2026-11-10, from the payloadcms/payload measurement): a test that imports `{ x }`
// from a side-effect-free barrel depends only on the files that define `x`.
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { exportLevelReach } from "../../src/repo/export-reach.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { ModuleBindings } from "../../src/repo/types.js";

const mod = (locals: string[], imports: ModuleBindings["imports"] = {}, reexports: ModuleBindings["reexports"] = {}, extra: Partial<ModuleBindings> = {}): ModuleBindings =>
  ({ locals, imports, reexports, sideEffectFree: true, ...extra });
const fwd = (pairs: string[]) => ({ pairs: pairs.map((p): [string, string] => [p, p]), star: false, namespaces: [] });
const star = { pairs: [], star: true, namespaces: [] };

describe("exportLevelReach", () => {
  const barrel: Record<string, ModuleBindings> = {
    "t.test.ts": mod([], { "lib/index.ts": ["a"] }, {}, { sideEffectFree: false }),
    "lib/index.ts": mod([], {}, { "lib/a.ts": fwd(["a"]), "lib/b.ts": fwd(["b"]), "lib/more.ts": star }),
    "lib/a.ts": mod(["a"], { "lib/util.ts": ["u"] }),
    "lib/b.ts": mod(["b"]),
    "lib/more.ts": mod(["m"]),
    "lib/util.ts": mod(["u"]),
  };
  const deps = (bindings: Record<string, ModuleBindings>) => (file: string) => [...new Set([...Object.keys(bindings[file]?.imports ?? {}), ...Object.keys(bindings[file]?.reexports ?? {})])];

  it("follows a named import through a barrel to the defining file and its imports", () => {
    const reach = exportLevelReach("t.test.ts", barrel, deps(barrel));
    assert.ok(reach.has("lib/index.ts") && reach.has("lib/a.ts") && reach.has("lib/util.ts"));
    assert.ok(!reach.has("lib/b.ts") && !reach.has("lib/more.ts"));
  });
  it("searches `export *` sources for a name and counts the ones it consulted", () => {
    const b = { ...barrel, "t.test.ts": mod([], { "lib/index.ts": ["m"] }, {}, { sideEffectFree: false }) };
    const reach = exportLevelReach("t.test.ts", b, deps(b));
    assert.ok(reach.has("lib/more.ts") && !reach.has("lib/a.ts") && !reach.has("lib/b.ts"));
  });
  it("takes the whole module for a namespace import, an opaque module, a package without the contract, or an unknown name", () => {
    const whole = (b: Record<string, ModuleBindings>) => { const r = exportLevelReach("t.test.ts", b, deps(b)); return ["lib/a.ts", "lib/b.ts", "lib/more.ts"].every((f) => r.has(f)); };
    assert.ok(whole({ ...barrel, "t.test.ts": mod([], { "lib/index.ts": "*" }, {}, { sideEffectFree: false }) }));
    assert.ok(whole({ ...barrel, "lib/index.ts": { ...barrel["lib/index.ts"]!, opaque: true } }));
    assert.ok(whole({ ...barrel, "lib/index.ts": { ...barrel["lib/index.ts"]!, sideEffectFree: false } }));
    assert.ok(whole({ ...barrel, "t.test.ts": mod([], { "lib/index.ts": ["missing"] }, {}, { sideEffectFree: false }) }));
  });
  it("takes the whole module when a dependency has no bindings at all", () => {
    const b = { ...barrel };
    delete (b as Record<string, ModuleBindings | undefined>)["lib/index.ts"];
    const reach = exportLevelReach("t.test.ts", b, (file) => file === "t.test.ts" ? ["lib/index.ts"] : deps(barrel)(file));
    assert.ok(reach.has("lib/b.ts") && reach.has("lib/more.ts"));
  });
});

describe("export-level selection end to end", () => {
  function write(dir: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  }
  const base = (sideEffects: unknown) => ({
    "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0" } }),
    "vitest.config.ts": `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n`,
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true }, include: ["packages", "tests"] }),
    "packages/lib/package.json": JSON.stringify({ name: "lib", type: "module", ...(sideEffects === undefined ? {} : { sideEffects }) }),
    "packages/lib/src/index.ts": `export { a } from "./a.js";\nexport { b } from "./b.js";\nexport * from "./c.js";\nexport { d } from "./d.js";\n`,
    "packages/lib/src/a.ts": `export const a = 1;\n`,
    "packages/lib/src/b.ts": `import { a } from "./a.js";\nexport const b = a + 1;\n`,
    "packages/lib/src/c.ts": `export const c = 3;\n`,
    "packages/lib/src/d.ts": `export const d = 4;\n`,
    "tests/a.test.ts": `import { a } from "../packages/lib/src/index.js";\nimport { test } from "vitest";\ntest("a", () => a);\n`,
    "tests/b.test.ts": `import { b } from "../packages/lib/src/index.js";\nimport { test } from "vitest";\ntest("b", () => b);\n`,
    "tests/c.test.ts": `import { c } from "../packages/lib/src/index.js";\nimport { test } from "vitest";\ntest("c", () => c);\n`,
  });
  async function selected(sideEffects: unknown, change: Record<string, string>, extra: Record<string, string> = {}): Promise<{ tests: string[]; evidence: string[] }> {
    const dir = join(tmpdir(), `diffci-export-reach-${randomUUID()}`);
    try {
      mkdirSync(dir, { recursive: true });
      write(dir, { ...base(sideEffects), ...extra });
      execSync("git init --quiet && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit --quiet -m base", { cwd: dir });
      const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      write(dir, change);
      execSync("git -c user.email=t@t -c user.name=t commit --quiet -am head", { cwd: dir });
      const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
      assert.ok(delta.success);
      const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
      const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
      return { tests: impact.affectedTests.map((t) => t.path).sort(), evidence: impact.evidence.map((e) => e.message) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("selects only the tests whose imported names reach the changed file", async () => {
    const { tests, evidence } = await selected(false, { "packages/lib/src/a.ts": `export const a = 2;\n` });
    assert.deepEqual(tests, ["tests/a.test.ts", "tests/b.test.ts"]);
    assert.ok(evidence.some((m) => m.includes("export-level selection")));
  });
  it("finds a name re-exported with `export *`", async () => {
    assert.deepEqual((await selected(false, { "packages/lib/src/c.ts": `export const c = 30;\n` })).tests, ["tests/c.test.ts"]);
  });
  it("selects every importer when the barrel itself changes", async () => {
    const { tests } = await selected(false, { "packages/lib/src/index.ts": `export { a } from "./a.js";\nexport { b } from "./b.js";\nexport * from "./c.js";\n` });
    assert.deepEqual(tests, ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
  });
  it("keeps one importer to load a changed file no test reaches by name", async () => {
    const { tests, evidence } = await selected(false, { "packages/lib/src/d.ts": `export const d = 40;\n` });
    assert.deepEqual(tests, ["tests/a.test.ts"]);
    assert.ok(evidence.some((m) => m.includes("is kept to load it")));
  });
  it("keeps a test that imports only a type when tests may be type-checked as they run", async () => {
    const typeOnly = {
      "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0", tstyche: "^4.0.0" } }),
      "packages/lib/src/d.ts": `export type D = { d: number };
export const d = 4;
`,
      "tests/e.test.ts": `import type { D } from "../packages/lib/src/index.js";
import { a } from "../packages/lib/src/index.js";
import { test } from "vitest";
const x: D = { d: a };
test("e", () => x);
`,
    };
    const { tests } = await selected(false, { "packages/lib/src/d.ts": `export type D = { d: string };
export const d = 4;
` }, typeOnly);
    assert.ok(tests.includes("tests/e.test.ts"), tests.join(","));
  });
  it("selects for a computed load in a function only the tests that reach its module by name", async () => {
    const loader = {
      "packages/lib/src/index.ts": `export { a } from "./a.js";
export { b } from "./b.js";
export * from "./c.js";
export { d } from "./d.js";
export { load } from "./load.js";
`,
      "packages/lib/src/load.ts": `export async function load(name: string) {
  return import(name);
}
`,
      "tests/load.test.ts": `import { load } from "../packages/lib/src/index.js";
import { test } from "vitest";
test("load", () => load("x"));
`,
    };
    const { tests } = await selected(false, { "packages/lib/src/c.ts": `export const c = 30;
` }, loader);
    assert.deepEqual(tests, ["tests/c.test.ts", "tests/load.test.ts"]);
  });
  for (const [label, body] of [["at module top level", `const mod = await import(process.env.X ?? "x");
export const load = () => mod;
`], ["in an immediately invoked function", `export const load = (() => import(process.env.X ?? "x"))();
`]] as const) {
    it(`keeps every importer of a module with a computed load ${label}`, async () => {
      const loader = {
        "packages/lib/src/index.ts": `export { a } from "./a.js";
export { b } from "./b.js";
export * from "./c.js";
export { d } from "./d.js";
export { load } from "./load.js";
`,
        "packages/lib/src/load.ts": body,
        "tests/load.test.ts": `import { load } from "../packages/lib/src/index.js";
import { test } from "vitest";
test("load", () => load);
`,
      };
      const { tests } = await selected(false, { "packages/lib/src/c.ts": `export const c = 30;
` }, loader);
      assert.deepEqual(tests, ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/load.test.ts"]);
    });
  }
  it("accepts a sideEffects list naming only stylesheets", async () => {
    assert.deepEqual((await selected(["*.css"], { "packages/lib/src/c.ts": `export const c = 30;\n` })).tests, ["tests/c.test.ts"]);
  });
  it("stays file level when the package does not declare the side-effect contract", async () => {
    for (const sideEffects of [undefined, true, ["./src/setup.ts"]]) {
      assert.deepEqual((await selected(sideEffects, { "packages/lib/src/a.ts": `export const a = 2;\n` })).tests, ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
    }
  });
});
