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
    const receipt = JSON.stringify({ ...report, execution: { ...report.execution, stdoutTail: "", stderrTail: "", testResults: undefined } });
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
