import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeRepository } from "@diffci.com/core/repo/analyzer";
import { commandSpecToString, planSelectiveTestCommands } from "@diffci.com/core/planner/test-command";
import { executableSelection } from "../../src/client/verify.js";
import type { ObservationReport } from "../../src/client/report.js";

type Result = NonNullable<ObservationReport["result"]>;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "diffci-verify-multi-"));
  const write = (path: string, content: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); };
  write("package.json", JSON.stringify({ scripts: { test: "pnpm -r run test" } }));
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
  for (const name of ["a", "b"]) {
    write(`packages/${name}/package.json`, JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.8" } }));
    write(`packages/${name}/vitest.config.ts`, "export default {test:{include:['src/**/*.test.ts']}};");
    write(`packages/${name}/src/value.test.ts`, "import {test} from 'vitest'; test('value',()=>{});");
  }
  return dir;
}

const selectedTests = ["packages/a/src/value.test.ts", "packages/b/src/value.test.ts"];
const result = (proposedCommands: string[]) => ({ mode: "SELECTIVE", selectedTests, totalTestCount: 2, fallbackReasons: [], proposedCommands }) as unknown as Result;

test("runs every command of a multi-command plan instead of the full suite", () => {
  const dir = workspace();
  try {
    const proposed = planSelectiveTestCommands(analyzeRepository({ repoPath: dir }), selectedTests).commands.map(commandSpecToString);
    assert.equal(proposed.length, 2);
    const plan = executableSelection(dir, result(proposed));
    assert.equal(plan.selection, "selected");
    assert.deepEqual(plan.commands, proposed);
    assert.equal(plan.command, proposed.join(" && "));
    assert.match(plan.reason, /2 commands from the verified plan/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("falls back to the full suite when the reported commands differ from the rebuilt plan", () => {
  const dir = workspace();
  try {
    const plan = executableSelection(dir, result(["pnpm --dir packages/a exec vitest run", "rm -rf /"]));
    assert.equal(plan.selection, "full");
    assert.equal(plan.command, "pnpm test");
    assert.match(plan.reason, /differ from the verified plan/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
