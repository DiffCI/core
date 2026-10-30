import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyRange } from "../../src/client/verify.js";
import { captureWorkingTreeSnapshot, snapshotChanges } from "../../src/client/working-tree.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** A two-commit repository whose test writes `testBody`'s side effects, plus the range between the commits. */
function fixture(testBody: string) {
  const repo = mkdtempSync(join(tmpdir(), "diffci-verify-snapshot-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@diffci.local");
  git(repo, "config", "user.name", "DiffCI test");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test test/" } }));
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true, module: "esnext", target: "es2022" }, include: ["src", "test"] }));
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "test", "a.test.js"), `import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\nimport { a } from "../src/a.js";\ntest("a", () => { ${testBody} if (a !== 2) throw new Error("a"); });\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.js"), "export const a = 2;\n");
  git(repo, "commit", "-q", "-am", "change");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

function verify(repo: string, base: string, head: string) {
  return verifyRange({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, baseOverride: base, headOverride: head, skipChecks: true });
}

test("snapshotChanges reports added, modified and deleted paths", () => {
  const { repo } = fixture("");
  try {
    const before = captureWorkingTreeSnapshot(repo);
    writeFileSync(join(repo, "new.txt"), "x");
    writeFileSync(join(repo, "src", "a.js"), "export const a = 3;\n");
    rmSync(join(repo, "test", "a.test.js"));
    const after = captureWorkingTreeSnapshot(repo);
    assert.deepEqual(snapshotChanges(repo, before.treeSha, after.treeSha), [
      { path: "new.txt", status: "added" },
      { path: "src/a.js", status: "modified" },
      { path: "test/a.test.js", status: "deleted" },
    ]);
    assert.deepEqual(snapshotChanges(repo, before.treeSha, before.treeSha), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a file the tests create is listed and does not block the verdict", async () => {
  const { repo, base, head } = fixture(`writeFileSync(new URL("../fixture-output.json", import.meta.url), "{}");`);
  try {
    const report = await verify(repo, base, head);
    assert.equal(report.verification, "passed", report.reason);
    assert.equal(report.snapshot.unchanged, true);
    assert.deepEqual(report.snapshot.written_during_verification, ["fixture-output.json"]);
    assert.equal(report.snapshot.changed_during_verification, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a test failure is still reported when the tests also create a file", async () => {
  const { repo, base, head } = fixture(`writeFileSync(new URL("../fixture-output.json", import.meta.url), "{}"); throw new Error("broken");`);
  try {
    const report = await verify(repo, base, head);
    assert.equal(report.verification, "failed", report.reason);
    assert.deepEqual(report.snapshot.written_during_verification, ["fixture-output.json"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a change to a file that existed before the run still blocks, and names the file", async () => {
  const { repo, base, head } = fixture(`writeFileSync(new URL("../src/a.js", import.meta.url), "export const a = 2; // edited\\n");`);
  try {
    const report = await verify(repo, base, head);
    assert.equal(report.verification, "blocked");
    assert.equal(report.snapshot.unchanged, false);
    assert.deepEqual(report.snapshot.changed_during_verification, [{ path: "src/a.js", status: "modified" }]);
    assert.match(report.reason, /modified src\/a\.js/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
