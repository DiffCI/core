// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../src/analyze.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "diffci-core-checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("config", "user.name", "Core Test"); git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "synthetic", type: "module", scripts: { test: "node --test src/*.test.js" } }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }));
  writeFileSync(join(root, "src/value.js"), "export const value = 1;\n");
  writeFileSync(join(root, "src/value.test.js"), "import { value } from './value.js';\nif (value < 1) throw new Error('bad');\n");
  git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src/value.js"), "export const value = 2;\n");
  git("add", "."); git("commit", "-m", "change"); const head = git("rev-parse", "HEAD");
  return { root, git, base, head };
}

test("standalone checkout analysis selects the dependent test and returns an advisory plan", async () => {
  const f = fixture();
  try {
    const result = await analyzeCheckout({ repoPath: f.root, base: f.base, head: f.head });
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.head, f.head);
    assert.ok(result.plan.selectedTests.includes("src/value.test.js"));
    assert.equal(f.git("status", "--porcelain"), "");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("analysis refuses a different checkout, dirty files, untracked files and invalid revisions", async () => {
  const f = fixture();
  try {
    await assert.rejects(analyzeCheckout({ repoPath: f.root, base: f.base, head: f.base }), /Checkout must be at/);
    await assert.rejects(analyzeCheckout({ repoPath: f.root, base: "not-a-revision", head: f.head }));
    writeFileSync(join(f.root, "src/value.js"), "export const value = 3;\n");
    await assert.rejects(analyzeCheckout({ repoPath: f.root, base: f.base, head: f.head }), /must be clean/);
    f.git("checkout", "--", "src/value.js");
    writeFileSync(join(f.root, "untracked.txt"), "untracked");
    await assert.rejects(analyzeCheckout({ repoPath: f.root, base: f.base, head: f.head }), /must be clean/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("workflow changes retain full fallback and always-run security policy", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
    writeFileSync(join(f.root, ".github/workflows/ci.yml"), "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n");
    f.git("add", "."); f.git("commit", "-m", "workflow");
    const result = await analyzeCheckout({ repoPath: f.root, base: f.head, head: "HEAD" });
    assert.equal(result.plan.mode, "FULL");
    assert.equal(result.plan.safety.fallbackRequired, true);
    assert.deepEqual(result.plan.skippedTests, []);
    assert.ok(result.plan.alwaysRunTasks.includes("security:default"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
