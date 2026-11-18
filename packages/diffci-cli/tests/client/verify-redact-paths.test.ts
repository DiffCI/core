import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyChanged } from "../../src/client/verify.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

const digest = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 12);

/** Two sources, each with its own node:test file, and an uncommitted change to `src/a.js`. */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "diffci-verify-redact-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@diffci.local");
  git(repo, "config", "user.name", "DiffCI test");
  for (const dir of ["src", "test"]) mkdirSync(join(repo, dir));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true, module: "esnext", target: "es2022" }, include: ["src", "test"] }));
  for (const name of ["a", "b"]) {
    writeFileSync(join(repo, "src", `${name}.js`), `export const ${name} = 1;\n`);
    writeFileSync(join(repo, "test", `${name}.test.js`), `import { test } from "node:test";\nimport { ${name} } from "../src/${name}.js";\ntest("${name}", () => { if (${name} < 0) throw new Error("${name}"); });\n`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "src", "a.js"), "export const a = 2;\n");
  return repo;
}

test("--redact-paths still runs the selected tests, and the receipt carries only digests of their paths", async () => {
  const repo = fixture();
  try {
    const report = await verifyChanged({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, redactPaths: true, skipChecks: true, reuse: false });
    assert.equal(report.verification, "passed", report.reason);
    assert.equal(report.selection, "selected", report.reason);
    assert.doesNotMatch(report.reason, /broadened to full verification/);
    assert.deepEqual(report.selected_tests, [digest("test/a.test.js")]);
    assert.deepEqual(Object.keys(report.selection_reasons ?? {}), [digest("test/a.test.js")]);
    assert.equal(report.selection_reasons?.[digest("test/a.test.js")]?.changed_file, digest("src/a.js"));
    const receipt = JSON.stringify(report);
    assert.equal(receipt.includes("test/a.test.js"), false, "the receipt names no selected test path");
    assert.equal(receipt.includes("src/a.js"), false, "the receipt names no changed path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("without --redact-paths the receipt keeps the real paths", async () => {
  const repo = fixture();
  try {
    const report = await verifyChanged({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, skipChecks: true, reuse: false });
    assert.equal(report.selection, "selected", report.reason);
    assert.deepEqual(report.selected_tests, ["test/a.test.js"]);
    assert.match(report.command ?? "", /test\/a\.test\.js/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--redact-paths keeps the paths out of gate checks, test results and output of a failing run", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test", check: "node scripts/check.js" } }));
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "check.js"), `import "../src/a.js";\n`);
    writeFileSync(join(repo, "test", "a.test.js"), `import { test } from "node:test";\nimport { a } from "../src/a.js";\ntest("a", () => { if (a === 2) throw new Error("a is 2"); });\n`);
    writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a check, and a test that fails when a is 2");
    writeFileSync(join(repo, "src", "a.js"), "export const a = 2;\n");
    const report = await verifyChanged({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, redactPaths: true, reuse: false });
    assert.equal(report.verification, "failed", report.reason);
    assert.equal(report.selection, "selected", report.reason);
    assert.ok(report.checks?.length, "the gate check ran");
    assert.ok(report.execution?.testResults?.length, "the run has per-file results");
    const receipt = JSON.stringify(report);
    assert.equal(receipt.includes("test/a.test.js"), false, "the receipt names no selected test path");
    assert.equal(receipt.includes("src/a.js"), false, "the receipt names no changed path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--redact-paths digests the files the run wrote or changed and the line-ending-only files", async () => {
  const repo = fixture();
  try {
    git(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, "src", "crlf.js"), "export const c = 1;\n");
    // The selected test writes a new file and changes a committed one while it runs.
    writeFileSync(join(repo, "test", "a.test.js"), `import { test } from "node:test";\nimport { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nimport { a } from "../src/a.js";\ntest("a", () => { mkdirSync("notes", { recursive: true }); writeFileSync("notes/written-by-run.txt", "x"); appendFileSync("src/b.js", "// touched\\n"); if (a < 0) throw new Error("a"); });\n`);
    writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a test that writes files");
    writeFileSync(join(repo, "src", "crlf.js"), "export const c = 1;\r\n");
    writeFileSync(join(repo, "src", "a.js"), "export const a = 2;\n");
    const report = await verifyChanged({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, redactPaths: true, skipChecks: true, reuse: false });
    assert.deepEqual(report.snapshot.written_during_verification, [digest("notes/written-by-run.txt")]);
    assert.deepEqual(report.snapshot.changed_during_verification, [{ path: digest("src/b.js"), status: "modified" }]);
    assert.deepEqual(report.snapshot.line_ending_only_changes, [digest("src/crlf.js")]);
    assert.match(report.reason, new RegExp(`modified ${digest("src/b.js")}`));
    const receipt = JSON.stringify(report);
    for (const path of ["notes/written-by-run.txt", "src/b.js", "src/crlf.js"]) assert.equal(receipt.includes(path), false, `the receipt names ${path}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--redact-paths digests a selected path the command passes as a node --test glob", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "test", "a[1].test.js"), `import { test } from "node:test";\nimport { a } from "../src/a.js";\ntest("a1", () => { if (a < 0) throw new Error("a"); });\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a bracketed test file");
    writeFileSync(join(repo, "src", "a.js"), "export const a = 3;\n");
    const report = await verifyChanged({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, redactPaths: true, skipChecks: true, reuse: false });
    assert.equal(report.selection, "selected", report.reason);
    assert.ok(report.selected_tests?.includes(digest("test/a[1].test.js")));
    assert.match(report.command ?? "", new RegExp(digest("test/a[1].test.js")));
    const receipt = JSON.stringify(report);
    assert.equal(/a@\(\[\[\]\)1|a\[1\]/.test(receipt), false, "the receipt names the bracketed test, as written or as a glob");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--redact-paths digests the separate project an outside-suite reason names", async () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test test/" } }));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true, module: "esnext", target: "es2022" }, include: ["src", "test", "apps"] }));
    mkdirSync(join(repo, "apps", "desk", "test"), { recursive: true });
    writeFileSync(join(repo, "apps", "desk", "package-lock.json"), "{}\n");
    // A brace list no node --test glob can match literally, so no command runs it from the root.
    writeFileSync(join(repo, "apps", "desk", "test", "d{x,y}.test.js"), `import { test } from "node:test";\nimport { a } from "../../../src/a.js";\ntest("d", () => { if (a < 0) throw new Error("a"); });\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a separate project");
    writeFileSync(join(repo, "src", "a.js"), "export const a = 3;\n");
    const report = await verifyChanged({ repoPath: repo, env: {}, version: "test", timeoutMs: 60_000, tailBytes: 4_000, redactPaths: true, skipChecks: true, reuse: false });
    assert.match(report.reason, new RegExp(`${digest("apps/desk")} is a separate project with its own lockfile`), report.reason);
    assert.equal(JSON.stringify(report).includes("apps/desk"), false, "the receipt names the separate project");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
