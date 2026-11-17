// SPDX-License-Identifier: MIT
/**
 * Mocha configuration files (issue #142, second half).
 *
 * A change to `.mocharc.json` fell back as an asset and `.mocharc.js` was worse: it is code nothing
 * imports, so the plan was SELECTIVE with **no tests at all**. Both decide how the suite runs, so a
 * change must fall back, and the reason now names the file:
 * `Tool configuration changed: Mocha settings (.mocharc.json); full validation required`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";

const TESTS = ["test/math.spec.js", "test/text.spec.js"];

function mochaProject(mochaFile: string, mochaContent: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "mocha-config-fixture",
      scripts: { test: "mocha" },
      devDependencies: { mocha: "11.7.0" },
    }),
    [mochaFile]: mochaContent,
    "src/math.js": "export const add = (a, b) => a + b;\nexport const shout = (s) => s.toUpperCase();\n",
    "test/math.spec.js": "import { add } from '../src/math.js';\nimport assert from 'node:assert/strict';\ndescribe('add', () => it('adds', () => assert.equal(add(1, 2), 3)));\n",
    "test/text.spec.js": "import { shout } from '../src/math.js';\nimport assert from 'node:assert/strict';\ndescribe('shout', () => it('shouts', () => assert.equal(shout('a'), 'A')));\n",
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-mocharc-"));
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
    writeFileSync(join(root, changedPath), changedContent);
    git("add", ".");
    git("commit", "-m", `change ${changedPath}`);
    const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CASES: Array<{ file: string; before: string; after: string }> = [
  { file: ".mocharc.json", before: '{"timeout":2000}\n', after: '{"timeout":5000}\n' },
  { file: ".mocharc.yml", before: "timeout: 2000\n", after: "timeout: 5000\n" },
  { file: ".mocharc.js", before: "module.exports = { timeout: 2000 };\n", after: "module.exports = { timeout: 5000 };\n" },
  { file: ".mocharc.cjs", before: "module.exports = { timeout: 2000 };\n", after: "module.exports = { timeout: 5000 };\n" },
];

for (const { file, before, after } of CASES) {
  test(`a change to only ${file} runs every test and names it as Mocha configuration`, async () => {
    const plan = await planForChange(mochaProject(file, before), file, after);
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.safety.fallbackRequired, true);
    assert.deepEqual([...plan.selectedTests].sort(), TESTS);
    assert.deepEqual(plan.skippedTests, []);
    assert.ok(
      plan.fallbackReasons.some(
        (text) => text.startsWith("Tool configuration changed: Mocha settings") && text.includes(file),
      ),
      plan.fallbackReasons.join("; "),
    );
    assert.ok(
      !plan.fallbackReasons.some((text) => text.includes(`Unknown changed file: ${file}`)),
      `still reported as unknown: ${plan.fallbackReasons.join("; ")}`,
    );
  });
}

// A plain `.mocharc` with no extension is Mocha's own form.
test("a change to only .mocharc runs every test and names it as Mocha configuration", async () => {
  const plan = await planForChange(mochaProject(".mocharc", "{\"timeout\":2000}\n"), ".mocharc", "{\"timeout\":5000}\n");
  assert.equal(plan.mode, "FULL");
  assert.deepEqual([...plan.selectedTests].sort(), TESTS);
  assert.ok(
    plan.fallbackReasons.some((text) => text.startsWith("Tool configuration changed: Mocha settings")),
    plan.fallbackReasons.join("; "),
  );
});

// The pattern is name-anchored like the other configuration entries, so a package's own
// `.mocharc.json` gets the same reason: it configures that package's suite.
test("packages/a/.mocharc.json gets the same reason", async () => {
  const files = mochaProject(".mocharc.json", '{"timeout":2000}\n');
  delete files[".mocharc.json"];
  files["packages/a/.mocharc.json"] = '{"timeout":2000}\n';
  const plan = await planForChange(files, "packages/a/.mocharc.json", '{"timeout":3000}\n');
  assert.ok(
    plan.fallbackReasons.some(
      (text) => text.startsWith("Tool configuration changed: Mocha settings") && text.includes("packages/a/.mocharc.json"),
    ),
    plan.fallbackReasons.join("; "),
  );
});
