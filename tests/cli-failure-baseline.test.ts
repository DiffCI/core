// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compareWithBaseline, failingTestNames } from "../packages/diffci-cli/src/client/failure-baseline.js";

describe("failingTestNames", () => {
  it("reads node:test spec, TAP, Vitest and Jest failures", () => {
    const output = [
      "✔ passes (1.2ms)",
      "✖ route list is current (3.4ms)",
      "✖ failing tests:",
      "\u001b[31m✖ route list is current (3.4ms)\u001b[39m",
      "not ok 7 - legacy tap case # time=2ms",
      " FAIL  src/a.test.ts > suite > vitest case",
      "  ● Suite › jest case",
    ].join("\n");
    assert.deepEqual(failingTestNames(output), ["Suite › jest case", "legacy tap case", "route list is current", "src/a.test.ts > suite > vitest case"]);
  });
});

describe("compareWithBaseline", () => {
  function fixture(): { dir: string; base: string; head: string } {
    const dir = join(tmpdir(), `diffci-baseline-test-${randomUUID()}`);
    mkdirSync(join(dir, "src"), { recursive: true });
    const run = (command: string) => execSync(command, { cwd: dir, encoding: "utf8" }).trim();
    run("git init -q && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", type: "module", scripts: { test: "node --test src/a.test.js" } }));
    writeFileSync(join(dir, "src/a.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "src/a.test.js"), `import test from "node:test"; import assert from "node:assert"; import { a } from "./a.js";\ntest("a is one", () => assert.equal(a, 1));\ntest("stale", () => assert.equal(1, 2));\n`);
    run("git add -A && git commit -qm base");
    const base = run("git rev-parse HEAD");
    writeFileSync(join(dir, "src/a.js"), "export const a = 2;\n");
    run("git commit -qam head");
    return { dir, base, head: run("git rev-parse HEAD") };
  }

  it("separates failures the change introduced from ones already failing at base", () => {
    const { dir, base, head } = fixture();
    try {
      const result = compareWithBaseline({ repoPath: dir, baseSha: base, headSha: head, commands: ["node --test src/a.test.js"], headFailures: ["a is one", "stale"], timeoutMs: 60_000 });
      assert.equal(result.status, "mixed");
      assert.deepEqual(result.preexisting, ["stale"]);
      assert.deepEqual(result.introduced, ["a is one"]);
      assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }), "");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("declines when failing tests cannot be named or dependencies differ", () => {
    const { dir, base, head } = fixture();
    try {
      assert.equal(compareWithBaseline({ repoPath: dir, baseSha: base, headSha: head, commands: ["true"], headFailures: [], timeoutMs: 1000 }).status, "unknown");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", type: "module", scripts: { test: "node --test" }, devDependencies: { x: "1" } }));
      execSync("git commit -qam deps", { cwd: dir });
      const moved = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
      const result = compareWithBaseline({ repoPath: dir, baseSha: base, headSha: moved, commands: ["true"], headFailures: ["stale"], timeoutMs: 1000 });
      assert.equal(result.status, "unknown");
      assert.match(result.reason, /dependency manifests or lockfiles differ/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("shares node_modules with the base run and never removes the real one", () => {
    const { dir, base, head } = fixture();
    try {
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      mkdirSync(join(dir, "node_modules/dep"), { recursive: true });
      writeFileSync(join(dir, "node_modules/dep/index.js"), "module.exports = 1;\n");
      const result = compareWithBaseline({ repoPath: dir, baseSha: base, headSha: head, commands: ["node -e \"require('dep'); process.exit(1)\""], headFailures: ["stale"], timeoutMs: 60_000 });
      assert.notEqual(result.status, "unknown", result.reason);
      assert.ok(existsSync(join(dir, "node_modules/dep/index.js")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
