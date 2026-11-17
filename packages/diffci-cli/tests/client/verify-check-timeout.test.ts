import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { verifyRange } from "../../src/client/verify.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** A two-commit repository whose gate runs a failing `scripts/check.js` before passing tests. */
function fixture(checkScript = `import "../src/a.js";\nprocess.exit(1);\n`) {
  const repo = mkdtempSync(join(tmpdir(), "diffci-verify-check-timeout-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@diffci.local");
  git(repo, "config", "user.name", "DiffCI test");
  for (const dir of ["src", "test", "scripts"]) mkdirSync(join(repo, dir));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { check: "node scripts/check.js", test: "node --test test/" } }));
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true, module: "esnext", target: "es2022" }, include: ["src", "test"] }));
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "scripts", "check.js"), checkScript);
  writeFileSync(join(repo, "test", "a.test.js"), `import { mock, test } from "node:test";\nimport { a } from "../src/a.js";\ntest("a", () => { if (a < 0) throw new Error("a"); });\n`);
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

/**
 * A gate check that "takes" the whole time limit: it writes a marker file, and from then on the mocked
 * clock reads `budgetMs` later. Real time cannot do this reliably, because the check's own run is capped
 * at the remaining time; the overrun comes from work around it (a base rerun, worktree setup).
 */
function checkUsingBudget(exitCode: number, budgetMs: number) {
  const markerDir = mkdtempSync(join(tmpdir(), "diffci-verify-check-clock-"));
  const marker = join(markerDir, "ran");
  const script = `import { writeFileSync } from "node:fs";\nimport "../src/a.js";\nwriteFileSync(${JSON.stringify(marker)}, "");\nprocess.exit(${exitCode});\n`;
  const realNow = Date.now.bind(Date);
  mock.method(Date, "now", () => realNow() + (existsSync(marker) ? budgetMs : 0));
  return { script, cleanup: () => { mock.restoreAll(); rmSync(markerDir, { recursive: true, force: true }); } };
}

test("gate checks that use the whole time limit stop the tests instead of starting them with no limit", async () => {
  const budgetMs = 60_000;
  const clock = checkUsingBudget(0, budgetMs);
  const { repo, base, head } = fixture(clock.script);
  try {
    const report = await verifyRange({ repoPath: repo, env: {}, version: "test", timeoutMs: budgetMs, tailBytes: 4_000, baseOverride: base, headOverride: head });
    assert.equal(report.checks?.[0]?.status, "passed");
    assert.notEqual(report.verification, "passed", report.reason);
    assert.equal(report.safe_to_continue, false);
    assert.match(report.reason, /gate checks used the whole 60000ms time limit \(\d+ms\); tests were not run/);
    assert.equal(report.execution?.timedOut, true);
  } finally {
    clock.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a failed gate check that used the whole time limit is not rerun at the base with no limit", async () => {
  const budgetMs = 60_000;
  const clock = checkUsingBudget(1, budgetMs);
  const { repo, base, head } = fixture(clock.script);
  try {
    const report = await verifyRange({ repoPath: repo, env: {}, version: "test", timeoutMs: budgetMs, tailBytes: 4_000, baseOverride: base, headOverride: head, baselineOnFailure: true });
    assert.equal(report.checks?.[0]?.status, "failed");
    assert.deepEqual(report.checks?.[0]?.baseline, { status: "unknown", base_sha: base, reason: "the time limit ran out before the base run" });
    assert.notEqual(report.verification, "passed", report.reason);
  } finally {
    clock.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});
