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

// TypeScript resolves `paths` without `baseUrl` against the tsconfig that declares them. A `.vue` import
// through such an alias was resolved against the importer's own directory, was never found, and every
// change fell back as "Unresolved Vue dependencies".
function write(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
}

async function change(prefix: string, paths: Record<string, string[]>, baseUrl?: string) {
  const dir = join(tmpdir(), `diffci-vue-alias-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    execSync("git init --quiet && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    const component = (text: string) => `<template><div>${text}</div></template>\n<script setup lang="ts">\nconst x = 1;\n</script>\n`;
    write(dir, {
      "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "vitest run" }, dependencies: { vue: "^3.4.0" }, devDependencies: { vitest: "^2.0.0" } }),
      [`${prefix}tsconfig.json`]: JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", ...(baseUrl ? { baseUrl } : {}), paths }, include: ["src/**/*.ts", "src/**/*.vue"] }),
      [`${prefix}src/components/A.vue`]: component("a"),
      [`${prefix}src/lib/use.ts`]: "import A from '@/components/A.vue';\nexport const comp = A;\n",
      [`${prefix}src/lib/use.test.ts`]: "import { comp } from './use';\nimport { test } from 'vitest';\ntest('x', () => { void comp; });\n",
    });
    execSync("git add -A && git commit --quiet -m base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(dir, { [`${prefix}src/components/A.vue`]: component("b") });
    execSync("git add -A && git commit --quiet -m head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
    return { tests: impact.affectedTests.map((t) => t.path), fallback: impact.fallbackReasons };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a .vue import through paths without baseUrl resolves from the tsconfig directory", async () => {
  assert.deepEqual(await change("", { "@/*": ["./src/*"] }), { tests: ["src/lib/use.test.ts"], fallback: [] });
});

test("the same holds for a nested package's tsconfig", async () => {
  assert.deepEqual(await change("packages/app/", { "@/*": ["./src/*"] }), { tests: ["packages/app/src/lib/use.test.ts"], fallback: [] });
});

test("paths with baseUrl keep resolving from baseUrl", async () => {
  assert.deepEqual(await change("", { "@/*": ["src/*"] }, "."), { tests: ["src/lib/use.test.ts"], fallback: [] });
});
