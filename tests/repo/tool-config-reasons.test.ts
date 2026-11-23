// SPDX-License-Identifier: MIT
/**
 * Node version and package-manager configuration files (issue #142).
 *
 * A change to only one of these files falls back to the full suite, which is right: nothing can prove
 * which tests would notice. The reason used to be `Unknown changed file: <path>`, which reads like a gap
 * in DiffCI rather than a decision, so a user could not tell the two apart. Each now names what the file
 * controls.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";

const TESTS = ["src/math.test.js", "src/text.test.js"];

function jestProject(toolFile: string, toolContent: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "tool-config-fixture",
      scripts: { test: "jest" },
      devDependencies: { jest: "29.7.0" },
    }),
    [toolFile]: toolContent,
    "src/math.js": "export const add = (a, b) => a + b;\n",
    "src/math.test.js": "import { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n",
    "src/text.js": "export const shout = (s) => s.toUpperCase();\n",
    "src/text.test.js": "import { shout } from './text';\ntest('shout', () => expect(shout('a')).toBe('A'));\n",
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-tool-config-"));
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
    git("add", "."); git("commit", "-m", `change ${changedPath}`); const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CASES: Array<{ file: string; before: string; after: string; reason: string }> = [
  { file: ".nvmrc", before: "22\n", after: "24\n", reason: "Tool configuration changed: Node version" },
  { file: ".node-version", before: "22.5.0\n", after: "24.1.0\n", reason: "Tool configuration changed: Node version" },
  { file: ".npmrc", before: "save-exact=true\n", after: "save-exact=false\n", reason: "Tool configuration changed: package manager settings" },
  // Tool versions (issue #321): the Node, Python and Bun versions the suite runs on.
  { file: ".tool-versions", before: "nodejs 22.5.0\n", after: "nodejs 24.1.0\n", reason: "Tool configuration changed: tool versions" },
  { file: "mise.toml", before: '[tools]\nnode = "22.5.0"\n', after: '[tools]\nnode = "24.1.0"\n', reason: "Tool configuration changed: tool versions" },
  { file: ".mise.toml", before: '[tools]\nnode = "22.5.0"\n', after: '[tools]\nnode = "24.1.0"\n', reason: "Tool configuration changed: tool versions" },
  // mise.local.toml is mise's machine-local override, so it picks the toolchain just as mise.toml does.
  { file: "mise.local.toml", before: '[tools]\nnode = "22.5.0"\n', after: '[tools]\nnode = "24.1.0"\n', reason: "Tool configuration changed: tool versions" },
  { file: ".mise.local.toml", before: '[tools]\nnode = "22.5.0"\n', after: '[tools]\nnode = "24.1.0"\n', reason: "Tool configuration changed: tool versions" },
  { file: ".bun-version", before: "1.1.0\n", after: "1.2.0\n", reason: "Tool configuration changed: Bun version" },
  // Yarn Berry's binary and plugins (2026-11-23): `.yarnrc.yml` loads them by path, and nothing imports
  // them, so a change to only one of them used to select no tests and be marked safe.
  { file: ".yarn/releases/yarn-4.5.0.cjs", before: "// yarn 4.5.0\n", after: "// rewritten\n", reason: "Tool configuration changed: package manager" },
  { file: ".yarn/plugins/@yarnpkg/plugin-workspace-tools.cjs", before: "// v1\n", after: "// v2\n", reason: "Tool configuration changed: package manager" },
];

test("a change to only a Yarn editor SDK file selects no tests", async () => {
  // .yarn/sdks/ is for editors (TypeScript server, ESLint in VS Code); no install or test run loads it.
  const file = ".yarn/sdks/typescript/lib/tsserver.js";
  const plan = await planForChange(jestProject(file, "// v1\n"), file, "// v2\n");
  assert.equal(plan.mode, "SELECTIVE");
  assert.deepEqual(plan.selectedTests, []);
  assert.deepEqual(plan.fallbackReasons, []);
});

for (const { file, before, after, reason } of CASES) {
  test(`a change to only ${file} runs every test and names what the file controls`, async () => {
    const plan = await planForChange(jestProject(file, before), file, after);
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.safety.fallbackRequired, true);
    assert.deepEqual([...plan.selectedTests].sort(), TESTS);
    assert.deepEqual(plan.skippedTests, []);
    assert.ok(
      plan.fallbackReasons.some((text) => text.startsWith(reason) && text.includes(file)),
      plan.fallbackReasons.join("; "),
    );
    assert.ok(
      !plan.fallbackReasons.some((text) => text.includes(`Unknown changed file: ${file}`)),
      `still reported as unknown: ${plan.fallbackReasons.join("; ")}`,
    );
  });
}
