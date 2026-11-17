import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyRange } from "../../src/client/verify.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** A two-commit repository whose gate runs a failing `scripts/check.js` before passing tests. */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "diffci-verify-check-timeout-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@diffci.local");
  git(repo, "config", "user.name", "DiffCI test");
  for (const dir of ["src", "test", "scripts"]) mkdirSync(join(repo, dir));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { check: "node scripts/check.js", test: "node --test test/" } }));
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true, module: "esnext", target: "es2022" }, include: ["src", "test"] }));
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "scripts", "check.js"), `import "../src/a.js";\nprocess.exit(1);\n`);
  writeFileSync(join(repo, "test", "a.test.js"), `import { test } from "node:test";\nimport { a } from "../src/a.js";\ntest("a", () => { if (a < 0) throw new Error("a"); });\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.js"), "export const a = 2;\n");
  git(repo, "commit", "-q", "-am", "change");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

test("a gate check the time limit left no room for fails the verdict instead of being skipped", async () => {
  const { repo, base, head } = fixture();
  try {
    const report = await verifyRange({ repoPath: repo, env: {}, version: "test", timeoutMs: 0, tailBytes: 4_000, baseOverride: base, headOverride: head });
    assert.equal(report.checks?.[0]?.status, "not_run");
    assert.notEqual(report.verification, "passed", report.reason);
    assert.equal(report.safe_to_continue, false);
    assert.match(report.reason, /did not run within the 0ms time limit; tests were not run/);
    assert.equal(report.execution?.timedOut, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
