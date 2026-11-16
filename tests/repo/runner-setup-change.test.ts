// SPDX-License-Identifier: MIT
/**
 * Test setup files and Vitest workspace files run around every test, but nothing imports them, so a change
 * to one used to give a SELECTIVE plan with no tests (issues #139 and #140). Each case here changes only
 * that file and expects every test to run, with a fallback reason that names it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";
import { runnerSetupFiles } from "../../src/repo/runner-setup-files.js";

const TESTS = ["src/math.test.ts", "src/text.test.ts"];
const vitestPackage = JSON.stringify({ name: "setup-fixture", private: true, type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0" } });
const jestPackage = (jest?: object) => JSON.stringify({ name: "setup-fixture", private: true, scripts: { test: "jest" }, devDependencies: { jest: "29.7.0", "ts-jest": "29.0.0" }, ...(jest ? { jest } : {}) });

function project(runner: "vitest" | "jest", files: Record<string, string>): Record<string, string> {
  const imports = runner === "vitest" ? "import { expect, test } from 'vitest';\n" : "";
  return {
    "package.json": runner === "vitest" ? vitestPackage : jestPackage(),
    "src/math.ts": "export const add = (a: number, b: number) => a + b;\n",
    "src/math.test.ts": `${imports}import { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n`,
    "src/text.ts": "export const shout = (s: string) => s.toUpperCase();\n",
    "src/text.test.ts": `${imports}import { shout } from './text';\ntest('shout', () => expect(shout('a')).toBe('A'));\n`,
    ...files,
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-runner-setup-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init"); git("config", "user.name", "Core Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
    mkdirSync(dirname(join(root, changedPath)), { recursive: true });
    writeFileSync(join(root, changedPath), changedContent);
    git("add", "."); git("commit", "-m", "change"); const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFullRun(plan: Awaited<ReturnType<typeof planForChange>>, path: string) {
  assert.equal(plan.mode, "FULL");
  assert.equal(plan.safety.fallbackRequired, true);
  assert.deepEqual([...plan.selectedTests].sort(), TESTS);
  assert.deepEqual(plan.skippedTests, []);
  assert.ok(plan.fallbackReasons.some((reason) => reason.includes(path)), plan.fallbackReasons.join("; "));
}

const setupV1 = "(globalThis as any).ready = 1;\n";
const setupV2 = "(globalThis as any).ready = 2;\n";

const cases: Array<{ name: string; runner: "vitest" | "jest"; files: Record<string, string>; changed: string }> = [
  {
    name: "a Vitest setupFiles entry",
    runner: "vitest",
    files: { "vitest.config.ts": "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { setupFiles: ['./test/setup.ts'] } });\n", "test/setup.ts": setupV1 },
    changed: "test/setup.ts",
  },
  {
    name: "a Vitest globalSetup entry named without its extension",
    runner: "vitest",
    files: { "vitest.config.mts": "export default { test: { globalSetup: './test/global' } };\n", "test/global.ts": setupV1 },
    changed: "test/global.ts",
  },
  {
    name: "a Vitest setup file in vite.config.ts",
    runner: "vitest",
    files: { "vite.config.ts": "import { defineConfig } from 'vite';\nexport default defineConfig({ test: { setupFiles: 'vitest.setup.ts' } });\n", "vitest.setup.ts": setupV1 },
    changed: "vitest.setup.ts",
  },
  {
    name: "a Jest setupFilesAfterEnv entry under <rootDir>",
    runner: "jest",
    files: { "jest.config.js": "module.exports = { preset: 'ts-jest', setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'] };\n", "jest.setup.ts": setupV1 },
    changed: "jest.setup.ts",
  },
  {
    name: "a Jest globalSetup entry",
    runner: "jest",
    files: { "jest.config.cjs": "module.exports = { preset: 'ts-jest', globalSetup: './test/global-setup.ts' };\n", "test/global-setup.ts": "export default async () => {};\n" },
    changed: "test/global-setup.ts",
  },
  {
    name: "a Jest setupFiles entry in package.json",
    runner: "jest",
    files: { "package.json": jestPackage({ preset: "ts-jest", setupFiles: ["./test/env.ts"] }), "test/env.ts": setupV1 },
    changed: "test/env.ts",
  },
  {
    name: "a Jest setup file built with path.join",
    runner: "jest",
    files: { "jest.config.js": "const path = require('path');\nmodule.exports = { preset: 'ts-jest', setupFiles: [path.join(__dirname, 'test', 'polyfills.ts')] };\n", "test/polyfills.ts": setupV1 },
    changed: "test/polyfills.ts",
  },
];

for (const c of cases) {
  test(`a change to only ${c.name} runs every test (#139)`, async () => {
    const plan = await planForChange(project(c.runner, c.files), c.changed, setupV2);
    assertFullRun(plan, c.changed);
  });
}

test("a change to a module a setup file imports runs every test (#139)", async () => {
  const files = project("vitest", {
    "vitest.config.ts": "export default { test: { setupFiles: ['./test/setup.ts'] } };\n",
    "test/setup.ts": "import { install } from './matchers';\ninstall();\n",
    "test/matchers.ts": "export const install = () => {};\n",
  });
  const plan = await planForChange(files, "test/matchers.ts", "export const install = () => { (globalThis as any).x = 1; };\n");
  assertFullRun(plan, "test/matchers.ts");
});

test("a setup key DiffCI cannot read makes any source change run every test (#139)", async () => {
  const files = project("vitest", {
    "vitest.config.ts": "import { setup } from './test/list';\nexport default { test: { setupFiles: setup } };\n",
    "test/list.ts": "export const setup = ['./test/setup.ts'];\n",
    "test/setup.ts": setupV1,
  });
  const plan = await planForChange(files, "test/setup.ts", setupV2);
  assertFullRun(plan, "vitest.config.ts");
});

test("a source change outside every setup file still selects only its tests", async () => {
  const files = project("vitest", {
    "vitest.config.ts": "export default { test: { setupFiles: ['./test/setup.ts'] } };\n",
    "test/setup.ts": setupV1,
  });
  const plan = await planForChange(files, "src/math.ts", "export const add = (a: number, b: number) => b + a;\n");
  assert.equal(plan.mode, "SELECTIVE");
  assert.deepEqual([...plan.selectedTests], ["src/math.test.ts"]);
});

for (const workspace of ["vitest.workspace.ts", "vitest.workspace.json", "vitest.projects.mjs", "packages/web/vitest.workspace.ts"]) {
  test(`a change to only ${workspace} runs every test (#140)`, async () => {
    const before = workspace.endsWith(".json") ? '["."]\n' : "export default ['.'];\n";
    const after = workspace.endsWith(".json") ? '[{ "test": { "environment": "jsdom" } }]\n' : "export default [{ test: { environment: 'jsdom' } }];\n";
    const plan = await planForChange(project("vitest", { [workspace]: before }), workspace, after);
    assertFullRun(plan, workspace);
  });
}

test("runnerSetupFiles ignores runner names that are not files and paths outside the repository", () => {
  const files = ["jest.config.js", "jsdom.ts", "test/setup.ts", "src/index.ts"];
  const read = (path: string) => path === "jest.config.js"
    ? "module.exports = { testEnvironment: 'node', reporters: ['default'], setupFiles: ['../outside.ts', 'https://example.invalid/x.js', './test/setup'] };\n"
    : undefined;
  const result = runnerSetupFiles(files, read);
  assert.deepEqual([...result.named], [["test/setup.ts", "jest.config.js"]]);
  assert.deepEqual(result.unreadable, []);
});
