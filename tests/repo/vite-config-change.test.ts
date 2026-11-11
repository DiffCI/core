// SPDX-License-Identifier: MIT
/**
 * A Vitest project with no `vitest.config.*`, where the head commit changes only `vite.config.*`
 * (issue #98). Vitest then reads its `test` block from `vite.config.*`, so an edit to `test.include`,
 * `resolve.alias` or a plugin can change which tests run and what they import. `CONFIG_PATTERNS` does not
 * list `vite.config.`, but the impact analyzer's language/framework configuration rule falls back to a
 * full run for it, at the root and in a package directory. This fixture records that behaviour.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";

const viteConfig = (include: string, alias = "./src") =>
  "import { defineConfig } from 'vite';\n" +
  `export default defineConfig({ resolve: { alias: { '@': '${alias}' } }, test: { include: ['${include}'] } });\n`;

function vitestProject(configPath: string, prefix: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "vite-config-fixture", private: true, type: "module",
      scripts: { test: "vitest run" }, devDependencies: { vite: "^6.0.0", vitest: "^3.0.0" },
    }),
    [configPath]: viteConfig(`${prefix}src/**/*.test.ts`),
    [`${prefix}src/math.ts`]: "export const add = (a: number, b: number) => a + b;\n",
    [`${prefix}src/math.test.ts`]: "import { expect, test } from 'vitest';\nimport { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n",
    [`${prefix}src/text.ts`]: "export const shout = (s: string) => s.toUpperCase();\n",
    [`${prefix}src/text.test.ts`]: "import { expect, test } from 'vitest';\nimport { shout } from './text';\ntest('shout', () => expect(shout('a')).toBe('A'));\n",
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-vite-config-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init"); git("config", "user.name", "Core Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, changedPath), changedContent);
    git("add", "."); git("commit", "-m", "change vite config"); const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = [
  { name: "a test.include edit in vite.config.ts", configPath: "vite.config.ts", prefix: "", edit: (p: string) => viteConfig(`${p}src/math.test.ts`) },
  { name: "a resolve.alias edit in vite.config.ts", configPath: "vite.config.ts", prefix: "", edit: (p: string) => viteConfig(`${p}src/**/*.test.ts`, "./lib") },
  { name: "a test.include edit in vite.config.mjs", configPath: "vite.config.mjs", prefix: "", edit: (p: string) => viteConfig(`${p}src/math.test.ts`) },
  { name: "a test.include edit in a package's vite.config.ts", configPath: "packages/web/vite.config.ts", prefix: "packages/web/", edit: (p: string) => viteConfig(`${p}src/math.test.ts`) },
];

for (const c of cases) {
  test(`${c.name}, with no vitest.config, runs every test`, async () => {
    const plan = await planForChange(vitestProject(c.configPath, c.prefix), c.configPath, c.edit(c.prefix));
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.safety.fallbackRequired, true);
    assert.deepEqual([...plan.selectedTests].sort(), [`${c.prefix}src/math.test.ts`, `${c.prefix}src/text.test.ts`]);
    assert.deepEqual(plan.skippedTests, []);
    assert.ok(plan.fallbackReasons.includes(`Language/framework configuration changed: ${c.configPath}`), plan.fallbackReasons.join("; "));
  });
}
