import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { writeAgentStopHook } from "../../src/client/agent-setup.js";
import { decideStop } from "../../src/client/agent-stop.js";
import type { VerificationReport } from "../../src/client/verify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function report(verification: VerificationReport["verification"], fields: Partial<VerificationReport> = {}): VerificationReport {
  return {
    schema: "diffci.verification.v1", schema_version: "1", produced_at: "", scope: "working-tree", verification, safe_to_continue: verification === "passed",
    reason: verification === "failed" ? "verification command failed with exit code 1" : "dependency impact", changed_files: 1, tests_available: 2, tests_selected: 1,
    selection: "selected", command: "node --test test/a.test.js",
    snapshot: { base_sha: "b", before_tree_sha: "t", unchanged: true }, analysis: { status: "OBSERVED", fallback_reasons: [] }, required_actions: [], ...fields,
  };
}

describe("agent stop decisions (2026-11-06)", () => {
  const failed = report("failed", { execution: { command: "", exitCode: 1, signal: null, timedOut: false, startedAt: "", finishedAt: "", wallMs: 1, stdoutTail: "", stderrTail: "", failingTests: ["a adds"] } });

  it("asks Claude Code and Codex to continue with the failures, and Cursor through a follow-up", () => {
    for (const agent of ["claude", "codex"] as const) {
      const decision = decideStop(agent, failed, 0, 3);
      const output = JSON.parse(decision.stdout);
      assert.equal(output.decision, "block");
      assert.match(output.reason, /attempt 1 of 3[\s\S]*Failing tests: a adds/);
      assert.equal(decision.failures, 1);
    }
    assert.match(JSON.parse(decideStop("cursor", failed, 1, 3).stdout).followup_message, /attempt 2 of 3/);
  });

  it("passes quietly, resetting the count, and never holds the agent when verification could not run", () => {
    assert.deepEqual(decideStop("claude", report("passed"), 2, 3), { stdout: "{}", failures: 0 });
    const blocked = decideStop("codex", report("blocked", { reason: "the working tree changed during DiffCI analysis" }), 1, 3);
    assert.match(JSON.parse(blocked.stdout).systemMessage, /could not verify/);
    assert.equal(JSON.parse(blocked.stdout).decision, undefined);
    assert.deepEqual(JSON.parse(decideStop("cursor", undefined, 0, 3).stdout), {});
  });

  it("hands back to the person after the maximum attempts", () => {
    const decision = decideStop("claude", failed, 3, 3);
    assert.equal(JSON.parse(decision.stdout).decision, undefined);
    assert.match(JSON.parse(decision.stdout).systemMessage, /still fails after 3 attempt/);
  });
});

describe("agent stop hook files", () => {
  it("adds the hook beside other hooks, replaces only its own, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-hooks-"));
    try {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: {
        Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }, { type: "command", command: "npx --yes \"@diffci.com/diffci@0.3.1\" agent-stop --agent claude" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
      } }));
      assert.match(writeAgentStopHook(dir, "claude", "npx --no-install diffci"), /updated \.claude\/settings\.json/);
      const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
      assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
      assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }]);
      assert.deepEqual(settings.hooks.Stop, [
        { hooks: [{ type: "command", command: "./notify.sh" }] },
        { hooks: [{ type: "command", command: "npx --no-install diffci agent-stop --agent claude", timeout: 1200 }] },
      ]);
      assert.match(writeAgentStopHook(dir, "claude", "npx --no-install diffci"), /kept .*current/);

      assert.match(writeAgentStopHook(dir, "cursor", "npx --no-install diffci"), /wrote \.cursor\/hooks\.json/);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, ".cursor/hooks.json"), "utf8")), { version: 1, hooks: { stop: [{ command: "npx --no-install diffci agent-stop --agent cursor", loop_limit: 3 }] } });
      writeAgentStopHook(dir, "codex", "npx --no-install diffci");
      assert.equal(JSON.parse(readFileSync(join(dir, ".codex/hooks.json"), "utf8")).hooks.Stop[0].hooks[0].command, "npx --no-install diffci agent-stop --agent codex");

      writeFileSync(join(dir, ".codex/hooks.json"), "{ broken");
      assert.match(writeAgentStopHook(dir, "codex", "npx --no-install diffci"), /kept .*not a JSON object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("diffci agent-stop", () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-stop-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "--quiet");
    git("config", "user.email", "test@diffci.local");
    git("config", "user.name", "Test");
    const write = (path: string, contents: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), contents); };
    write("package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }));
    write("src/a.js", "export const a = () => 1;\n");
    write("test/a.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import { a } from '../src/a.js'; test('a', () => assert.equal(a(), 1));\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "initial");
    return dir;
  }
  const env = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && !name.startsWith("GITHUB_") && name !== "CI"));
  const stop = (dir: string, agent: string, payload: object, extra: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", CLI, "agent-stop", "--agent", agent],
    { cwd: ROOT, encoding: "utf8", timeout: 600_000, input: JSON.stringify(payload), env: { ...env(), ...extra } });

  it("asks the agent to fix a failing change, gives up after the maximum, and passes once fixed", () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, "src/a.js"), "export const a = () => 2;\n");
      const payload = { session_id: "s1", cwd: join(dir, "src"), hook_event_name: "Stop", stop_hook_active: false };
      const first = stop(dir, "claude", payload, { DIFFCI_AGENT_HOOK_MAX: "2" });
      assert.equal(first.status, 0, first.stderr);
      const blocked = JSON.parse(first.stdout);
      assert.equal(blocked.decision, "block");
      assert.match(blocked.reason, /attempt 1 of 2/);

      assert.equal(JSON.parse(stop(dir, "claude", payload, { DIFFCI_AGENT_HOOK_MAX: "2" }).stdout).decision, "block");
      const handedBack = JSON.parse(stop(dir, "claude", payload, { DIFFCI_AGENT_HOOK_MAX: "2" }).stdout);
      assert.equal(handedBack.decision, undefined);
      assert.match(handedBack.systemMessage, /over to you/);

      writeFileSync(join(dir, "src/a.js"), "export const a = () => 1; // fixed\n");
      assert.equal(stop(dir, "claude", payload, { DIFFCI_AGENT_HOOK_MAX: "2" }).stdout.trim(), "{}");
      assert.equal(stop(dir, "cursor", { conversation_id: "c1", workspace_roots: [dir], loop_count: 0 }, { DIFFCI_AGENT_HOOK_MAX: "2" }).stdout.trim(), "{}");
      assert.equal(stop(dir, "codex", payload, { DIFFCI_AGENT_HOOK: "0" }).stdout.trim(), "{}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
