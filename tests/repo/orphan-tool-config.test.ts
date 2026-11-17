// SPDX-License-Identifier: MIT
/**
 * Code a tool loads by name, not through an import (2026-11-17).
 *
 * A change to `.c8rc.js`, `ava.config.js`, `karma.conf.js` or `.mocharc.js` reached no test through the
 * graph, so the plan was SELECTIVE with nothing selected and no reason: a silent skip. A JavaScript or
 * TypeScript file with a configuration-style name anywhere, or any one at the repository root, that no
 * file imports now falls back with a reason naming it. An unused module under `src/` still selects
 * nothing, and an imported `*.config.*` module is still planned through its importers.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";

const TESTS = ["test/math.test.js", "test/text.test.js"];
const REASON = (path: string) => `Code that no file imports changed: ${path}; a tool may load it by name, so full validation required`;

function project(extra: Record<string, string>): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "orphan-fixture", scripts: { test: "mocha" }, devDependencies: { mocha: "11.7.0" } }),
    "src/math.js": "export const add = (a, b) => a + b;\n",
    "src/text.js": "export const shout = (s) => s.toUpperCase();\n",
    "test/math.test.js": "import { add } from '../src/math.js';\nit('adds', () => add(1, 2));\n",
    "test/text.test.js": "import { shout } from '../src/text.js';\nit('shouts', () => shout('a'));\n",
    ...extra,
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-orphan-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init");
    git("config", "user.name", "Core Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(dirname(join(root, changedPath)), { recursive: true });
    writeFileSync(join(root, changedPath), changedContent);
    git("add", ".");
    git("commit", "-m", `change ${changedPath}`);
    const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const BEFORE = "module.exports = { timeout: 2000 };\n";
const AFTER = "module.exports = { timeout: 5000 };\n";

// `.mocharc.cjs` is not in this list: a Mocha configuration is classified before this fallback and gets
// the reason that names it (see tests/repo/mocharc-config-fallback.test.ts).
for (const file of [".c8rc.js", "ava.config.js", "karma.conf.js", "Gruntfile.js", "packages/a/karma.conf.js", "packages/a/.c8rc.cjs"]) {
  test(`a change to only ${file}, which nothing imports, runs every test and names it`, async () => {
    const plan = await planForChange(project({ [file]: BEFORE }), file, AFTER);
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.safety.fallbackRequired, true);
    assert.deepEqual([...plan.selectedTests].sort(), TESTS);
    assert.deepEqual(plan.skippedTests, []);
    assert.ok(plan.fallbackReasons.includes(REASON(file)), plan.fallbackReasons.join("; "));
  });
}

test("an added root-level config file falls back too", async () => {
  const plan = await planForChange(project({}), "ava.config.mjs", "export default { files: ['test/**'] };\n");
  assert.equal(plan.mode, "FULL");
  assert.ok(plan.fallbackReasons.includes(REASON("ava.config.mjs")), plan.fallbackReasons.join("; "));
});

test("an unused module under src/ still selects nothing: no tool loads it by name", async () => {
  const plan = await planForChange(project({ "src/unused.js": BEFORE }), "src/unused.js", AFTER);
  assert.equal(plan.mode, "SELECTIVE");
  assert.deepEqual(plan.selectedTests, []);
  assert.deepEqual(plan.fallbackReasons, []);
});

test("an imported *.config.* module is planned through its importers", async () => {
  const files = project({
    "src/site.config.js": "export const title = 'a';\n",
    "src/text.js": "import { title } from './site.config.js';\nexport const shout = (s) => (s + title).toUpperCase();\n",
  });
  const plan = await planForChange(files, "src/site.config.js", "export const title = 'b';\n");
  assert.equal(plan.mode, "SELECTIVE");
  assert.deepEqual(plan.selectedTests, ["test/text.test.js"]);
  assert.ok(!plan.fallbackReasons.some((reason) => reason.startsWith("Code that no file imports")), plan.fallbackReasons.join("; "));
});

test("declaring the file in inputs narrows it to the declared tests", async () => {
  const files = project({
    "karma.conf.js": BEFORE,
    "diffci.json": JSON.stringify({ inputs: [{ files: ["karma.conf.js"], tests: ["test/math.test.js"] }] }),
  });
  const plan = await planForChange(files, "karma.conf.js", AFTER);
  assert.ok(!plan.fallbackReasons.includes(REASON("karma.conf.js")), plan.fallbackReasons.join("; "));
});
