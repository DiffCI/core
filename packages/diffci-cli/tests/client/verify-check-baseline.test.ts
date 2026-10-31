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

/**
 * A two-commit repository whose gate runs `scripts/check.js` before the tests. The test fails when
 * `a` is 2; the check fails when `checkFails` is true for the current `a`. The change sets `a` to `head`.
 */
function fixture(checkFails: string, head: number) {
  const repo = mkdtempSync(join(tmpdir(), "diffci-verify-check-baseline-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@diffci.local");
  git(repo, "config", "user.name", "DiffCI test");
  for (const dir of ["src", "test", "scripts"]) mkdirSync(join(repo, dir));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { check: "node scripts/check.js", test: "node --test test/" } }));
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true, module: "esnext", target: "es2022" }, include: ["src", "test"] }));
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "scripts", "check.js"), `import { a } from "../src/a.js";\nif (${checkFails}) process.exit(1);\n`);
  writeFileSync(join(repo, "test", "a.test.js"), `import { test } from "node:test";\nimport { a } from "../src/a.js";\ntest("a", () => { if (a === 2) throw new Error("a"); });\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.js"), `export const a = ${head};\n`);
  git(repo, "commit", "-q", "-am", "change");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

function verify(repo: string, base: string, head: string, baselineOnFailure: boolean) {
  return verifyRange({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, baseOverride: base, headOverride: head, baselineOnFailure });
}

test("a check already failing at the base does not hide a test the change broke", async () => {
  const { repo, base, head } = fixture("true", 2);
  try {
    const report = await verify(repo, base, head, true);
    assert.equal(report.verification, "failed", report.reason);
    assert.equal(report.safe_to_continue, false);
    assert.equal(report.checks?.[0]?.status, "failed");
    assert.equal(report.checks?.[0]?.baseline?.status, "preexisting");
    assert.match(report.reason, /verification command failed/);
    assert.match(report.reason, /also fail at the base commit/);
    assert.equal(report.failure_baseline?.status, "introduced");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("only a check already failing at the base still fails the verdict, and says nothing new broke", async () => {
  const { repo, base, head } = fixture("true", 4);
  try {
    const report = await verify(repo, base, head, true);
    assert.equal(report.verification, "failed", report.reason);
    assert.equal(report.execution?.exitCode, 0);
    assert.match(report.reason, /nothing this change introduced failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a check the change broke still stops verification before the tests", async () => {
  const { repo, base, head } = fixture("a === 3", 3);
  try {
    const report = await verify(repo, base, head, true);
    assert.equal(report.verification, "failed", report.reason);
    assert.equal(report.checks?.[0]?.baseline?.status, "introduced");
    assert.match(report.reason, /gate check check failed.*tests were not run/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("without --baseline-on-failure a failing check stops verification as before", async () => {
  const { repo, base, head } = fixture("true", 2);
  try {
    const report = await verify(repo, base, head, false);
    assert.equal(report.verification, "failed", report.reason);
    assert.equal(report.checks?.[0]?.baseline, undefined);
    assert.match(report.reason, /tests were not run/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
