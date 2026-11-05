import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAtBaseline } from "../../src/client/failure-baseline.js";
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

test("a check killed at the base (out of memory) is not read as already broken", async () => {
  // LobeHub, 2026-11-04: `type-check` was killed with exit 137 at the base while verify held its heap.
  const { repo, base, head } = fixture(`a === 1 ? process.exit(137) : a === 3`, 3);
  try {
    const report = await verify(repo, base, head, true);
    assert.equal(report.checks?.[0]?.status, "failed");
    assert.equal(report.checks?.[0]?.baseline?.status, "unknown");
    assert.match(report.checks?.[0]?.baseline?.reason ?? "", /killed \(exit code 137/);
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

test("a check that needs a workspace package's own node_modules is rerun at the base with them", async () => {
  // LobeHub, 2026-11-03: `type-check` resolves dependencies installed under each pnpm workspace
  // package. With only the root node_modules in the base tree it failed there too, so a type error
  // the change introduced read as already broken and verify ran the tests instead.
  const repo = mkdtempSync(join(tmpdir(), "diffci-verify-check-baseline-ws-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@diffci.local");
    git(repo, "config", "user.name", "DiffCI test");
    for (const dir of ["src", "test", "packages/p/node_modules/dep", "node_modules"]) mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", workspaces: ["packages/*"], scripts: { check: "node packages/p/check.cjs", test: "node --test test/" } }));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true, module: "esnext", target: "es2022" }, include: ["src", "test"] }));
    writeFileSync(join(repo, "packages/p/package.json"), JSON.stringify({ name: "p", private: true, dependencies: { dep: "1.0.0" } }));
    writeFileSync(join(repo, "packages/p/node_modules/dep/index.js"), "module.exports = 1;\n");
    writeFileSync(join(repo, "packages/p/check.cjs"), `require("dep");\nconst a = require("fs").readFileSync(require("path").join(__dirname, "../../src/a.js"), "utf8");\nif (a.includes("= 3")) process.exit(1);\n`);
    writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
    writeFileSync(join(repo, "test", "a.test.js"), `import { test } from "node:test";\ntest("a", () => {});\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src", "a.js"), "export const a = 3;\n");
    git(repo, "commit", "-q", "-am", "change");
    const report = await verify(repo, base, git(repo, "rev-parse", "HEAD"), true);
    assert.equal(report.checks?.[0]?.status, "failed");
    assert.equal(report.checks?.[0]?.baseline?.status, "introduced", report.checks?.[0]?.baseline?.reason);
    assert.match(report.reason, /gate check check failed.*tests were not run/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a check rerun at the base resolves workspace packages from the base, not from head", async () => {
  // Package managers install a workspace's own packages as links in node_modules (`node_modules/w ->
  // packages/w`). Linking the repository's node_modules into the base tree kept those links pointing at
  // head, so an error the change introduced in a workspace package also showed at the base and read as
  // already broken (2026-11-05).
  const repo = mkdtempSync(join(tmpdir(), "diffci-verify-check-baseline-link-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@diffci.local");
    git(repo, "config", "user.name", "DiffCI test");
    for (const dir of ["test", "packages/w", "node_modules/dep"]) mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"], scripts: { check: "node check.cjs", test: "node --test test/" } }));
    writeFileSync(join(repo, "packages/w/package.json"), JSON.stringify({ name: "w", main: "index.js" }));
    writeFileSync(join(repo, "packages/w/index.js"), "module.exports = 1;\n");
    writeFileSync(join(repo, "node_modules/dep/index.js"), "module.exports = 0;\n");
    symlinkSync(join(repo, "packages/w"), join(repo, "node_modules/w"), "junction");
    writeFileSync(join(repo, "check.cjs"), `require("dep");\nif (require("w") === 3) process.exit(1);\n`);
    writeFileSync(join(repo, "test", "a.test.js"), `const { test } = require("node:test");\ntest("a", () => {});\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "packages/w/index.js"), "module.exports = 3;\n");
    git(repo, "commit", "-q", "-am", "change");
    const baseline = checkAtBaseline({ repoPath: repo, baseSha: base, headSha: git(repo, "rev-parse", "HEAD"), command: "node check.cjs", timeoutMs: 60_000 });
    assert.equal(baseline.status, "introduced", baseline.reason);
    assert.equal(lstatSync(join(repo, "node_modules/w")).isSymbolicLink(), true, "the repository's own links are left alone");
    assert.equal(existsSync(join(repo, "node_modules/dep/index.js")), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
