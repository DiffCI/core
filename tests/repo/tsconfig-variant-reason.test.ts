// SPDX-License-Identifier: MIT
/**
 * `tsconfig.*.json` and `jsconfig.*.json` variants (issue #141).
 *
 * `tsconfig.json` changes were already configuration; a change to only `tsconfig.base.json` (extended by
 * `tsconfig.json`, as monorepos do) or a standalone `tsconfig.test.json` fell back with
 * `Unknown changed file: <path>`. Running everything is right — a compiler configuration decides every
 * file's types — but the reason read like a gap in DiffCI, so each is now named:
 * `Tool configuration changed: TypeScript configuration (tsconfig.base.json); full validation required`.
 *
 * The patterns are deliberately narrower than `type-program.ts`'s `tsconfig[^/]*\.json`: `tsconfig-paths.json`
 * is a package name, not a project configuration, and must stay unknown.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";

const TESTS = ["src/math.test.ts", "src/text.test.ts"];

const STRICT = JSON.stringify({
  compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" },
  include: ["src/**/*"],
});
const LOOSE = JSON.stringify({
  compilerOptions: { strict: false, target: "es2022", module: "esnext", moduleResolution: "bundler" },
  include: ["src/**/*"],
});

function tsProject(extra: Record<string, string>): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "ts-config-fixture",
      scripts: { test: "vitest" },
      devDependencies: { vitest: "3.0.0" },
    }),
    "tsconfig.json": STRICT,
    ...extra,
    "src/math.ts": "export const add = (a: number, b: number) => a + b;\n",
    "src/math.test.ts": "import { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n",
    "src/text.ts": "export const shout = (s: string) => s.toUpperCase();\n",
    "src/text.test.ts": "import { shout } from './text';\ntest('shout', () => expect(shout('a')).toBe('A'));\n",
  };
}

async function planForChange(files: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-tsconfig-"));
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

// The issue's two cases, plus a jsconfig variant.
for (const file of ["tsconfig.base.json", "tsconfig.test.json", "jsconfig.test.json"]) {
  test(`a change to only ${file} runs every test and names it as TypeScript configuration`, async () => {
    const plan = await planForChange(tsProject({ [file]: LOOSE }), file, STRICT);
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.safety.fallbackRequired, true);
    assert.deepEqual([...plan.selectedTests].sort(), TESTS);
    assert.deepEqual(plan.skippedTests, []);
    assert.ok(
      plan.fallbackReasons.some(
        (text) => text.startsWith("Tool configuration changed: TypeScript configuration") && text.includes(file),
      ),
      plan.fallbackReasons.join("; "),
    );
    assert.ok(
      !plan.fallbackReasons.some((text) => text.includes(`Unknown changed file: ${file}`)),
      `still reported as unknown: ${plan.fallbackReasons.join("; ")}`,
    );
  });
}

// The root `tsconfig.json` keeps its original reason: the generic configuration sentence covers it, and
// this change must not move it.
test("a change to only tsconfig.json keeps the general configuration reason", async () => {
  const plan = await planForChange(tsProject({}), "tsconfig.json", LOOSE);
  assert.equal(plan.mode, "FULL");
  assert.ok(
    plan.fallbackReasons.some((text) => text.startsWith("Configuration file(s) changed")),
    plan.fallbackReasons.join("; "),
  );
  assert.ok(
    !plan.fallbackReasons.some((text) => text.startsWith("Tool configuration changed: TypeScript configuration")),
    plan.fallbackReasons.join("; "),
  );
});

// A name the pattern must not match: `tsconfig-paths.json` is a package's config file, not a project one.
test("tsconfig-paths.json stays unknown", async () => {
  const plan = await planForChange(tsProject({ "tsconfig-paths.json": "x\n" }), "tsconfig-paths.json", "y\n");
  assert.equal(plan.mode, "FULL");
  assert.ok(
    plan.fallbackReasons.some((text) => text.includes("Unknown changed file: tsconfig-paths.json")),
    plan.fallbackReasons.join("; "),
  );
});
