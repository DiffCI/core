import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inferFullCommand } from "../../src/client/full-command.js";
import { auditEnforceWorkflows } from "../../src/client/workflow-guard.js";

// `bun test` is Bun's built-in test runner and never reads scripts.test; `bun run test` runs the script.
function bunRepository(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-bun-full-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test("a Bun repository's full command runs its test script, not Bun's own test runner", () => {
  const repositories: Array<Record<string, string>> = [
    { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "bun.lock": "" },
    { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "bun.lockb": "" },
    { "package.json": JSON.stringify({ packageManager: "bun@1.2.0", scripts: { test: "vitest run" } }) },
  ];
  for (const files of repositories) {
    const dir = bunRepository(files);
    try {
      assert.equal(inferFullCommand(dir).command, "bun run test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the enforce audit does not count `bun test` as a Bun repository's test script", () => {
  const workflow = (run: string) => `on:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
  const runs = (run: string) => {
    const dir = bunRepository({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "bun.lock": "",
      ".github/workflows/ci.yml": workflow(run),
    });
    try {
      return auditEnforceWorkflows(dir).fullSuiteJobs;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.deepEqual(runs("bun run test"), [".github/workflows/ci.yml#test"]);
  assert.deepEqual(runs("bun test"), []);
});
