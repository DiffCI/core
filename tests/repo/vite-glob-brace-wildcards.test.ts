// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";

// globPattern escaped brace alternatives as literal text, so `{index,*-icon}.ts` matched index.ts only.
// The glob loads star-icon.ts as well, and a change to it selected nothing.
async function globTargets(glob: string): Promise<{ targets: string[]; computed: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "diffci-vite-glob-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^2.0.0", vite: "^5.0.0" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
    "src/icons/index.ts": "export const i = 0;\n",
    "src/icons/star-icon.ts": "export const s = 1;\n",
    "src/icons/moon-icon.tsx": "export const m = 2;\n",
    "src/icons/extra/deep-icon.ts": "export const d = 3;\n",
    "src/registry.ts": `export const icons = import.meta.glob(${JSON.stringify(glob)}, { eager: true });\n`,
    "src/registry.test.ts": "import { icons } from './registry';\nimport { test } from 'vitest';\ntest('r', () => { void icons; });\n",
  };
  try {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
    const graph = await buildDependencyGraph({ repoPath: root });
    return {
      targets: graph.graph.edges.filter((edge) => edge.from === "src/registry.ts").map((edge) => edge.to).sort(),
      computed: graph.unresolved.some((ref) => ref.importer === "src/registry.ts" && ref.computed === true),
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a wildcard inside a brace alternative is a glob", async () => {
  assert.deepEqual(await globTargets("./icons/{index,*-icon}.ts"), { targets: ["src/icons/index.ts", "src/icons/star-icon.ts"], computed: false });
  assert.deepEqual(await globTargets("./icons/{*-icon.tsx,**/deep-*.ts}"), { targets: ["src/icons/extra/deep-icon.ts", "src/icons/moon-icon.tsx"], computed: false });
});

test("literal alternatives behave as before", async () => {
  assert.deepEqual(await globTargets("./icons/*-icon.{ts,tsx}"), { targets: ["src/icons/moon-icon.tsx", "src/icons/star-icon.ts"], computed: false });
});

test("nested braces stay computed", async () => {
  assert.deepEqual(await globTargets("./icons/{a,{b,c}}.ts"), { targets: [], computed: true });
});
