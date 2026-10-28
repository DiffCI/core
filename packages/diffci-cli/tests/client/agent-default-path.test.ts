import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOOK_MARKER, hookCommand, installPrePushHook, prePushHook } from "../../src/client/hook.js";
import { selectionInstruction, type AgentSelectionPlan } from "../../src/client/agent-selection.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-hook-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@diffci.local", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "base"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@diffci.local", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "head"], { cwd: dir });
  return dir;
}

test("the hook command is pinned or uses the installed binary", () => {
  assert.equal(hookCommand(undefined, "1.2.3"), 'npx --yes "@diffci.com/diffci@1.2.3"');
  assert.equal(hookCommand("pnpm", "1.2.3"), "pnpm exec diffci");
});

test("installs into the hooks directory and keeps a hook it did not write", () => {
  const dir = repo();
  try {
    assert.match(installPrePushHook(dir, "diffci", false), /^wrote \.git\/hooks\/pre-push/);
    assert.match(installPrePushHook(dir, "diffci", false), /^kept .*\(current\)/);
    writeFileSync(join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\necho mine\n");
    assert.match(installPrePushHook(dir, "diffci", false), /existing hook not written by DiffCI/);
    assert.equal(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8"), "#!/bin/sh\necho mine\n");
    assert.match(installPrePushHook(dir, "diffci", true), /^wrote/);
    // core.hooksPath (husky and similar) is respected.
    execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: dir });
    assert.match(installPrePushHook(dir, "diffci", false), /^wrote \.husky\/pre-push/);
    assert.ok(readFileSync(join(dir, ".husky", "pre-push"), "utf8").includes(HOOK_MARKER));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("blocks a push when verification fails, and lets it through when DiffCI cannot verify", () => {
  const dir = repo();
  try {
    const log = join(dir, "calls.log");
    const fake = join(dir, "fake-diffci.mjs");
    writeFileSync(fake, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(Number(process.env.FAKE_CODE));\n`);
    const hook = join(dir, "pre-push");
    writeFileSync(hook, prePushHook(`node ${JSON.stringify(fake).replace(/\\\\/g, "/")}`));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const base = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: dir, encoding: "utf8" }).trim();
    const push = (code: number, strict = false) => spawnSync("sh", [hook, "origin", "url"], {
      cwd: dir, encoding: "utf8", input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
      env: { ...process.env, FAKE_CODE: String(code), DIFFCI_HOOK_STRICT: strict ? "1" : "" },
    });
    assert.equal(push(0).status, 0);
    assert.equal(readFileSync(log, "utf8").trim().split("\n")[0], `verify --base ${base} --head ${head}`);
    const failed = push(1);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /push blocked/);
    assert.equal(push(2).status, 0);
    assert.equal(push(2, true).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the MCP selection leads with the one exact command to run", () => {
  const plan = {
    status: "planned", selection: "selected", tests_selected: 3, tests_available: 580,
    command: "npx tsx --test src/a.test.ts", reason: "dependency impact",
  } as unknown as AgentSelectionPlan;
  assert.equal(selectionInstruction(plan), "DiffCI selected 3 of 580 test files. Run exactly:\nnpx tsx --test src/a.test.ts\nDo not substitute your own test files or the full suite.");
  const full = { ...plan, selection: "full", command: "npm test", reason: "full verification required: Lockfile changed" } as unknown as AgentSelectionPlan;
  assert.match(selectionInstruction(full), /^DiffCI requires the full suite \(full verification required: Lockfile changed\)\. Run exactly:\nnpm test/);
  const blocked = { ...plan, status: "blocked", reason: "working tree changed during analysis; reanalyze" } as unknown as AgentSelectionPlan;
  assert.match(selectionInstruction(blocked), /^DiffCI could not plan this change/);
});
