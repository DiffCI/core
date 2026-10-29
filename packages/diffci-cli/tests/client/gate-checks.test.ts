import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { plannedChecks, runChecks } from "../../src/client/gate-checks.js";
import { selectionInstruction, type AgentSelectionPlan } from "../../src/client/agent-selection.js";

function repo(pkg: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-gate-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test("gate checks run as the repository's package manager would", () => {
  const scripts = { check: "npm run lint && tsc --noEmit && node scripts/arch.js", lint: "eslint .", test: "vitest run" };
  const npm = repo({ scripts });
  const pnpm = repo({ scripts }, { "pnpm-lock.yaml": "" });
  try {
    assert.deepEqual(plannedChecks(npm).map((c) => [c.id, c.command]), [
      ["lint", "npm run lint"],
      ["check[2]", "npx --no-install tsc --noEmit"],
      ["check[3]", "node scripts/arch.js"],
    ]);
    assert.equal(plannedChecks(pnpm)[0]!.command, "pnpm run lint");
  } finally {
    for (const dir of [npm, pnpm]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository without a readable gate has no checks", () => {
  const dir = repo({ scripts: { test: "vitest run" } });
  const broken = mkdtempSync(join(tmpdir(), "diffci-gate-"));
  writeFileSync(join(broken, "package.json"), "{");
  try {
    assert.deepEqual(plannedChecks(dir), []);
    assert.deepEqual(plannedChecks(broken), []);
  } finally {
    for (const d of [dir, broken]) rmSync(d, { recursive: true, force: true });
  }
});

test("checks stop at the first failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-gate-"));
  try {
    // `exit n` means the same in sh and cmd.exe.
    const check = (id: string, code: number) => ({ id, kind: "script" as const, command: `exit ${code}`, reason: "test" });
    const run = runChecks([check("a", 0), check("b", 3), check("c", 0)], { cwd: dir, timeoutMs: 60_000, tailBytes: 0 });
    assert.deepEqual(run.results.map((r) => [r.id, r.status]), [["a", "passed"], ["b", "failed"], ["c", "not_run"]]);
    assert.equal(run.failure?.check.id, "b");
    assert.equal(run.failure?.check.exit_code, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the MCP instruction puts the gate checks before the tests", () => {
  const plan = {
    status: "planned", selection: "selected", tests_selected: 3, tests_available: 580,
    command: "npx tsx --test src/a.test.ts", reason: "dependency impact",
    checks: [{ id: "lint", kind: "lint", command: "npm run lint", reason: "" }, { id: "typecheck", kind: "typecheck", command: "npm run typecheck", reason: "" }],
  } as unknown as AgentSelectionPlan;
  assert.equal(
    selectionInstruction(plan),
    "DiffCI selected 3 of 580 test files. The repository's gate also runs 2 check(s) (lint, typecheck); run them first. Run these commands in order, exactly as given:\nnpm run lint\nnpm run typecheck\nnpx tsx --test src/a.test.ts\nDo not substitute your own test files, checks or the full suite.",
  );
});
