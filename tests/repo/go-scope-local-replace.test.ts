// SPDX-License-Identifier: MIT
/**
 * `go.scope: root-module` with `replace example.com/x => ./x` pointing at a nested module inside the
 * repository (issue #81). go list reports the replaced packages the root build uses with their Dir in
 * the checkout, so a change there selects the root packages that import it instead of falling back.
 * Files of the replaced module that the root build does not use, other nested modules, and replacements
 * that do not point at a nested module root still fall back. Runs the real `go list` offline, and skips
 * when Go is not installed.
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

const ROOT_TESTS = ["app/app_test.go", "other/other_test.go"];

function files(replaceTarget = "./x", extra: Record<string, string> = {}): Record<string, string> {
  return {
    "diffci.json": '{\n  "go": { "scope": "root-module" }\n}\n',
    "go.mod": `module example.com/project\n\ngo 1.24\n\nrequire example.com/x v0.0.0\n\nreplace example.com/x => ${replaceTarget}\n`,
    "x/go.mod": "module example.com/x\n\ngo 1.24\n",
    "x/x.go": "package x\n\nfunc Value() int { return 1 }\n",
    "x/x_test.go": 'package x\n\nimport "testing"\n\nfunc TestValue(t *testing.T) { if Value() != 1 { t.Fatal(Value()) } }\n',
    "app/app.go": 'package app\n\nimport "example.com/x"\n\nfunc Double() int { return 2 * x.Value() }\n',
    "app/app_test.go": 'package app\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) { if Double() != 2 { t.Fatal(Double()) } }\n',
    "other/other.go": "package other\n\nconst Value = 3\n",
    "other/other_test.go": 'package other\n\nimport "testing"\n\nfunc TestValue(t *testing.T) { if Value != 3 { t.Fatal(Value) } }\n',
    ...extra,
  };
}

async function planForChange(tree: Record<string, string>, changedPath: string, changedContent: string) {
  const root = mkdtempSync(join(tmpdir(), "diffci-go-replace-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init"); git("config", "user.name", "Core Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (const [path, content] of Object.entries(tree)) {
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

function assertFull(plan: Awaited<ReturnType<typeof planForChange>>, reason: string) {
  assert.equal(plan.mode, "FULL");
  assert.equal(plan.safety.fallbackRequired, true);
  assert.deepEqual([...plan.selectedTests].sort(), ROOT_TESTS);
  assert.deepEqual(plan.skippedTests, []);
  assert.ok(plan.fallbackReasons.some((r) => r.includes(reason)), plan.fallbackReasons.join("; "));
}

test("a change in a replaced in-repository module selects the root packages that import it", { skip }, async () => {
  const plan = await planForChange(files(), "x/x.go", "package x\n\nfunc Value() int { return 2 }\n");
  assert.equal(plan.mode, "SELECTIVE", plan.fallbackReasons.join("; "));
  assert.equal(plan.safety.fallbackRequired, false);
  assert.deepEqual(plan.fallbackReasons, []);
  assert.deepEqual(plan.selectedTests, ["app/app_test.go"]);
  assert.deepEqual(plan.skippedTests, ["other/other_test.go"]);
});

test("the replace target written with a trailing slash is modelled the same way", { skip }, async () => {
  const plan = await planForChange(files("./x/"), "x/x.go", "package x\n\nfunc Value() int { return 2 }\n");
  assert.equal(plan.mode, "SELECTIVE", plan.fallbackReasons.join("; "));
  assert.deepEqual(plan.selectedTests, ["app/app_test.go"]);
});

test("a replaced module's own test is outside the root build and falls back", { skip }, async () => {
  const plan = await planForChange(files(), "x/x_test.go", 'package x\n\nimport "testing"\n\nfunc TestValue(t *testing.T) {}\n');
  assertFull(plan, "Go runtime inputs outside source/embed metadata");
});

test("a nested module that is not replaced stays excluded from the root-module scope", { skip }, async () => {
  const tree = files("./x", { "legacy/go.mod": "module example.com/legacy\n\ngo 1.24\n", "legacy/legacy.go": "package legacy\n\nconst Value = 1\n" });
  const plan = await planForChange(tree, "legacy/legacy.go", "package legacy\n\nconst Value = 2\n");
  assertFull(plan, "Changes in a Go module outside the declared root-module scope require full validation");
});
