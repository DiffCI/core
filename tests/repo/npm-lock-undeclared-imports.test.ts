// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { npmLockChangedTrees } from "../../src/repo/npm-lockfile.js";

// npm hoists `inner`, a dependency of `left`, to node_modules/inner, so src/uses-inner.js can import it
// without declaring it. A lockfile bump of inner is attributed to `left` only, which used to select
// src/uses-left.test.js and skip src/uses-inner.test.js.
function write(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
}
const lock = (inner: string) => JSON.stringify({
  name: "fixture", lockfileVersion: 3,
  packages: {
    "": { dependencies: { left: "^1" } },
    "node_modules/left": { version: "1.0.0", dependencies: { inner: "^1" } },
    "node_modules/inner": { version: inner },
    // Installed at the root but declared by nothing: unrelated to inner, and one that loads inner.
    "node_modules/steady": { version: "2.0.0" },
    "node_modules/wraps-inner": { version: "1.0.0", dependencies: { inner: "^1" } },
  },
}, null, 2);

async function bump(extra: Record<string, string>) {
  const dir = join(tmpdir(), `diffci-npm-undeclared-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(dir, {
      "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" }, dependencies: { left: "^1" } }, null, 2),
      "package-lock.json": lock("1.0.0"),
      "src/uses-left.js": `import left from "left";\nexport const value = left;\n`,
      "src/uses-left.test.js": `import { value } from "./uses-left.js";\nimport test from "node:test";\ntest("l", () => value);\n`,
      ...extra,
    });
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, { "package-lock.json": lock("1.1.0") });
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    return new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("an npm lockfile bump falls back when repository code imports a hoisted, undeclared package", async () => {
  const impact = await bump({
    "src/uses-inner.js": `import inner from "inner";\nexport const value = inner;\n`,
    "src/uses-inner.test.js": `import { value } from "./uses-inner.js";\nimport test from "node:test";\ntest("i", () => value);\n`,
  });
  assert.deepEqual(impact.fallbackReasons, ["npm lockfile changed and repository imports undeclared dependencies (inner); full validation required"]);
});

test("an npm lockfile bump still narrows when every import is declared", async () => {
  const impact = await bump({});
  assert.deepEqual(impact.fallbackReasons, []);
  assert.deepEqual(impact.affectedTests.map((t) => t.path), ["src/uses-left.test.js"]);
});

const usesUndeclared = (name: string, how = `import pkg from "${name}";`) => ({
  [`src/uses-${name}.js`]: `${how}
export const value = 1;
`,
  [`src/uses-${name}.test.js`]: `import { value } from "./uses-${name}.js";
import test from "node:test";
test("u", () => value);
`,
});

test("an npm lockfile bump narrows past an undeclared package whose installed tree did not move (2026-11-24)", async () => {
  const impact = await bump(usesUndeclared("steady"));
  assert.deepEqual(impact.fallbackReasons, []);
  assert.deepEqual(impact.affectedTests.map((t) => t.path), ["src/uses-left.test.js"]);
});

test("an npm lockfile bump narrows past an undeclared package that is not installed at all", async () => {
  // DentalPresence loads libphonenumber-js through createRequire from a folder outside the project.
  const impact = await bump(usesUndeclared("phone-lib", `const lib = createRequire(folder)("phone-lib/max");`));
  assert.deepEqual(impact.fallbackReasons, []);
});

test("an npm lockfile bump still falls back when an undeclared package loads what moved", async () => {
  const impact = await bump(usesUndeclared("wraps-inner"));
  assert.deepEqual(impact.fallbackReasons, ["npm lockfile changed and repository imports undeclared dependencies (wraps-inner); full validation required"]);
});

test("npmLockChangedTrees lists root packages whose installed tree changed, scoped names included", () => {
  const lockOf = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } });
  const before = lockOf({
    "node_modules/@img/sharp": { version: "1.0.0", dependencies: { libvips: "^1" } },
    "node_modules/libvips": { version: "1.0.0" },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/a/node_modules/b": { version: "1.0.0" },
    "node_modules/gone": { version: "1.0.0" },
  });
  const after = lockOf({
    "node_modules/@img/sharp": { version: "1.0.0", dependencies: { libvips: "^1" } },
    "node_modules/libvips": { version: "1.1.0" },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/a/node_modules/b": { version: "2.0.0" },
    "node_modules/new": { version: "1.0.0" },
  });
  // a's nested b moved, so a's tree moved; b is not a root install; gone and new changed by presence.
  assert.deepEqual(npmLockChangedTrees(before, after), ["@img/sharp", "a", "gone", "libvips", "new"]);
  assert.deepEqual(npmLockChangedTrees(before, before), []);
  assert.equal(npmLockChangedTrees(before, lockOf({ "packages/x": { version: "1.0.0" } })), undefined);
  assert.equal(npmLockChangedTrees(before, lockOf({ "node_modules/x": { link: true, resolved: "x" } })), undefined);
  assert.equal(npmLockChangedTrees("not json", after), undefined);
});
