// SPDX-License-Identifier: MIT
/**
 * A Jest project transformed by babel-jest, where the head commit changes only the Babel configuration
 * (issue #99). babel-jest applies `babel.config.*` and `.babelrc` to every test file it transforms, so
 * no test may be skipped: the only safe plan is a full run.
 *
 * Before this fixture, a `.babelrc` change fell back as an unknown file, but `babel.config.js` (and the
 * `.cjs`, `.mjs` and `.ts` forms) is a code file that nothing imports, so it was classified as source
 * with no dependents and the plan was SELECTIVE with zero tests selected.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";

const TESTS = ["src/math.test.js", "src/text.test.js"];

function jestProject(babelFile: string, babelContent: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "babel-jest-fixture",
      scripts: { test: "jest" },
      devDependencies: { jest: "29.7.0", "babel-jest": "29.7.0", "@babel/preset-env": "7.26.0" },
    }),
    [babelFile]: babelContent,
    "src/math.js": "export const add = (a, b) => a + b;\n",
    "src/math.test.js": "import { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n",
    "src/text.js": "export const shout = (s) => s.toUpperCase();\n",
    "src/text.test.js": "import { shout } from './text';\ntest('shout', () => expect(shout('a')).toBe('A'));\n",
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-babel-config-"));
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
    git("add", "."); git("commit", "-m", "change babel config"); const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const presetEnv = (node: string) => `module.exports = { presets: [['@babel/preset-env', { targets: { node: '${node}' } }]] };\n`;

for (const babelFile of ["babel.config.js", "babel.config.cjs", "babel.config.mjs", "babel.config.ts"]) {
  test(`a change to only ${babelFile} runs every Jest test`, async () => {
    const plan = await planForChange(jestProject(babelFile, presetEnv("current")), babelFile, presetEnv("18"));
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.safety.fallbackRequired, true);
    assert.deepEqual([...plan.selectedTests].sort(), TESTS);
    assert.deepEqual(plan.skippedTests, []);
    assert.ok(plan.fallbackReasons.some((reason) => reason.includes(babelFile)), plan.fallbackReasons.join("; "));
  });
}

test("a change to only .babelrc runs every Jest test", async () => {
  const babelrc = (node: string) => `${JSON.stringify({ presets: [["@babel/preset-env", { targets: { node } }]] })}\n`;
  const plan = await planForChange(jestProject(".babelrc", babelrc("current")), ".babelrc", babelrc("18"));
  assert.equal(plan.mode, "FULL");
  assert.equal(plan.safety.fallbackRequired, true);
  assert.deepEqual([...plan.selectedTests].sort(), TESTS);
  assert.deepEqual(plan.skippedTests, []);
  assert.ok(plan.fallbackReasons.some((reason) => reason.includes(".babelrc")), plan.fallbackReasons.join("; "));
});
