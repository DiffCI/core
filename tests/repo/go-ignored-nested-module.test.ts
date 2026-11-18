// SPDX-License-Identifier: MIT
/**
 * A go.mod under testdata/ (or a directory starting with `_` or `.`) is a fixture, not a nested module:
 * `go list ./...` never enters those directories. It must not make every change in the root module fall
 * back. Runs the real `go list` offline, and skips when Go is not installed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";

function goInstalled(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
const skip = goInstalled() ? false : "go is not installed";

const tree: Record<string, string> = {
  "go.mod": "module example.com/project\n\ngo 1.24\n",
  "a/a.go": "package a\n\nfunc F() int { return 1 }\n",
  "a/a_test.go": 'package a\n\nimport "testing"\n\nfunc TestF(t *testing.T) { if F() != 1 { t.Fatal(F()) } }\n',
  "a/testdata/fixturemod/go.mod": "module example.com/fixture\n\ngo 1.24\n",
  "a/testdata/fixturemod/main.go": "package main\n\nfunc main() {}\n",
  "_examples/demo/go.mod": "module example.com/demo\n\ngo 1.24\n",
  "_examples/demo/main.go": "package main\n\nfunc main() {}\n",
  "b/b.go": "package b\n\nfunc G() int { return 2 }\n",
  "b/b_test.go": 'package b\n\nimport "testing"\n\nfunc TestG(t *testing.T) { if G() != 2 { t.Fatal(G()) } }\n',
};

async function planForChange(changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-go-ignored-module-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init"); git("config", "user.name", "Core Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (const [path, content] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, changedPath), changedContent);
    git("add", "."); git("commit", "-m", "change"); const head = git("rev-parse", "HEAD");
    return (await analyzeCheckout({ repoPath: root, base, head })).plan;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a go.mod under testdata/ or _examples/ does not make the root module fall back", { skip }, async () => {
  const plan = await planForChange("b/b.go", "package b\n\nfunc G() int { return 1 + 1 }\n");
  assert.equal(plan.safety.fallbackRequired, false, plan.fallbackReasons.join("; "));
  assert.equal(plan.mode, "SELECTIVE");
  assert.deepEqual(plan.selectedTests, ["b/b_test.go"]);
  assert.deepEqual(plan.skippedTests, ["a/a_test.go"]);
});

test("a nested go.mod outside ignored directories still falls back", { skip }, async () => {
  tree["tools/go.mod"] = "module example.com/tools\n\ngo 1.24\n";
  tree["tools/main.go"] = "package main\n\nfunc main() {}\n";
  try {
    const plan = await planForChange("b/b.go", "package b\n\nfunc G() int { return 1 + 1 }\n");
    assert.equal(plan.mode, "FULL");
    assert.ok(plan.fallbackReasons.some((r) => r.includes("nested modules require full validation")), plan.fallbackReasons.join("; "));
  } finally {
    delete tree["tools/go.mod"];
    delete tree["tools/main.go"];
  }
});
