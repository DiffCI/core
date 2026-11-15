// SPDX-License-Identifier: MIT
/**
 * Issue #117: a tool configuration file in a workspace package, such as `packages/web/babel.config.js`
 * or `packages/web/jest.config.js`, configures every test of that package. CONFIG_PATTERNS is anchored at
 * the repository root, so before this a lone change to one of these gave a SELECTIVE plan with no tests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";
import { computeAnalysis, isNestedTestConfig } from "../../src/git/git-diff.js";

const WEB_TESTS = ["packages/web/src/math.test.js", "packages/web/src/text.test.js"];

function workspace(configFile: string, configContent: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "fixture-root", private: true, workspaces: ["packages/*"], scripts: { test: "npm test --workspaces" } }),
    "packages/web/package.json": JSON.stringify({
      name: "web",
      scripts: { test: "jest" },
      devDependencies: { jest: "29.7.0", "babel-jest": "29.7.0", "@babel/preset-env": "7.26.0" },
    }),
    [`packages/web/${configFile}`]: configContent,
    "packages/web/src/math.js": "export const add = (a, b) => a + b;\n",
    "packages/web/src/math.test.js": "import { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n",
    "packages/web/src/text.js": "export const shout = (s) => s.toUpperCase();\n",
    "packages/web/src/text.test.js": "import { shout } from './text';\ntest('shout', () => expect(shout('a')).toBe('A'));\n",
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-subdir-config-"));
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
    git("add", "."); git("commit", "-m", "change config"); const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const presetEnv = (node: string) => `module.exports = { presets: [['@babel/preset-env', { targets: { node: '${node}' } }]] };\n`;
const jestConfig = (env: string) => `module.exports = { testEnvironment: '${env}' };\n`;

const CASES: Array<[string, (v: string) => string, string, string]> = [
  ["babel.config.js", presetEnv, "current", "18"],
  [".babelrc.js", presetEnv, "current", "18"],
  ["jest.config.js", jestConfig, "node", "jsdom"],
  ["vitest.config.js", (v) => `export default { test: { environment: "${v}" } };\n`, "node", "jsdom"],
];

for (const [file, content, before, after] of CASES) {
  test(`a change to only packages/web/${file} runs every test in packages/web`, async () => {
    const path = `packages/web/${file}`;
    const plan = await planForChange(workspace(file, content(before)), path, content(after));
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.safety.fallbackRequired, true);
    assert.deepEqual([...plan.selectedTests].sort(), WEB_TESTS);
    assert.ok(plan.fallbackReasons.some((reason) => reason.includes(path)), plan.fallbackReasons.join("; "));
  });
}

test("only test-runner and transform configurations below the root count as nested test configuration", () => {
  for (const path of ["packages/web/jest.config.ts", "packages/web/vitest.config.mts", "apps/a/b/babel.config.cjs", "packages/web/.babelrc", "packages/web/.babelrc.json"]) {
    assert.equal(isNestedTestConfig(path), true, path);
  }
  // Root files stay with CONFIG_PATTERNS; vendored copies and look-alike names are not configuration.
  for (const path of ["jest.config.js", "babel.config.js", "node_modules/pkg/jest.config.js", "packages/web/node_modules/pkg/.babelrc", "packages/web/src/jest.setup.js", "packages/web/my-babel.config.js"]) {
    assert.equal(isNestedTestConfig(path), false, path);
  }
});

test("a nested test configuration sets the config signal and names its path", () => {
  const analysis = computeAnalysis([{ path: "packages/web/jest.config.js", changeType: "modified" }]);
  assert.equal(analysis.configChanged, true);
  assert.deepEqual(analysis.signalPaths?.config, ["packages/web/jest.config.js"]);
  const source = computeAnalysis([{ path: "packages/web/src/math.js", changeType: "modified" }]);
  assert.equal(source.configChanged, false);
});
