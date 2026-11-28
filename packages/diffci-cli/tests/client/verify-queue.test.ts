import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { readOutcomes } from "../../src/client/outcome-log.js";
import { acquireVerifyLock, verifyLockPath } from "../../src/client/verify-queue.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-verify-queue-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@diffci.local");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  write(dir, "package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }));
  write(dir, "src/alpha.js", "export const alpha = () => 1;\n");
  write(dir, "test/alpha.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import {alpha} from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 1));\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

function holdLock(dir: string, pid: number, token = "other"): string {
  const path = verifyLockPath(dir)!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, host: hostname(), started_at: new Date().toISOString(), scope: "verify --changed", cwd: dir, token }));
  return path;
}

/** A fake clock that advances by each sleep, so waits take no real time. */
function clock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

describe("acquireVerifyLock", () => {
  it("takes a free lock at once and frees it on release", async () => {
    const dir = repo();
    try {
      const lock = await acquireVerifyLock(dir, { scope: "verify --changed", timeoutMs: 1000 });
      const path = verifyLockPath(dir)!;
      assert.equal(lock.waited_for, undefined);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
      lock.release();
      assert.equal(existsSync(path), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("waits for a running verify, says for whom once, then takes the lock", async () => {
    const dir = repo();
    try {
      const path = holdLock(dir, 4242);
      const time = clock();
      const messages: string[] = [];
      let polls = 0;
      const lock = await acquireVerifyLock(dir, {
        scope: "verify --staged", timeoutMs: 60_000, pollMs: 1000, isAlive: () => true, now: time.now, log: (m) => messages.push(m),
        sleep: async (ms) => { await time.sleep(ms); if (++polls === 3) rmSync(path); },
      });
      assert.equal(lock.queued_ms, 3000);
      assert.equal(lock.waited_for?.pid, 4242);
      assert.equal(lock.timed_out, undefined);
      assert.equal(messages.length, 1);
      assert.match(messages[0]!, /waiting for another verify in this repository \(pid 4242, verify --changed/);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
      lock.release();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("removes a lock whose process is gone", async () => {
    const dir = repo();
    try {
      holdLock(dir, 4242);
      const messages: string[] = [];
      const lock = await acquireVerifyLock(dir, { scope: "verify --changed", timeoutMs: 60_000, isAlive: () => false, log: (m) => messages.push(m) });
      assert.equal(lock.waited_for, undefined);
      assert.match(messages[0]!, /removed a stale verify lock left by pid 4242/);
      lock.release();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs in parallel after the queue timeout and leaves the holder's lock alone", async () => {
    const dir = repo();
    try {
      const path = holdLock(dir, 4242);
      const time = clock();
      const lock = await acquireVerifyLock(dir, { scope: "verify --changed", timeoutMs: 5000, pollMs: 1000, isAlive: () => true, ...time });
      assert.equal(lock.timed_out, true);
      assert.equal(lock.queued_ms, 5000);
      assert.equal(lock.waited_for?.pid, 4242);
      lock.release();
      assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "other");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not remove a lock another run took over", async () => {
    const dir = repo();
    try {
      const lock = await acquireVerifyLock(dir, { scope: "verify --changed", timeoutMs: 1000 });
      const path = holdLock(dir, 4242, "newer");
      lock.release();
      assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "newer");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs unqueued outside a Git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-verify-queue-nogit-"));
    try {
      const lock = await acquireVerifyLock(dir, { scope: "verify --changed", timeoutMs: 1000 });
      assert.equal(lock.queued_ms, 0);
      lock.release();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

function verify(dir: string, extra: string[] = []): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && !name.startsWith("GITHUB_") && name !== "CI")), DO_NOT_TRACK: "1" };
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "verify", "--changed", "--repo", dir, "--json", ...extra], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

describe("diffci verify queue", () => {
  it("runs two verifies of one tree once: the second waits, then reuses the first", { timeout: 600_000 }, async () => {
    const dir = repo();
    try {
      write(dir, "src/alpha.js", "export const alpha = () => 1; // edited\n");
      const first = verify(dir);
      // Start the second once the first holds the lock.
      const path = verifyLockPath(dir)!;
      for (let i = 0; i < 600 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 100));
      const [a, b] = await Promise.all([first, verify(dir)]);
      assert.equal(a.status, 0, a.stdout + a.stderr);
      assert.equal(b.status, 0, b.stdout + b.stderr);
      const second = JSON.parse(b.stdout);
      assert.ok(second.reused_from, "the second run reused the first");
      assert.equal(second.queue.waited_for.pid > 0, true);
      assert.match(b.stderr, /waiting for another verify in this repository/);
      const records = readOutcomes(join(dir, ".git", "diffci", "outcomes.jsonl"));
      assert.equal(records.length, 2);
      assert.equal(typeof records[1]!.queued_ms, "number");
      assert.equal(existsSync(path), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("--no-queue runs without waiting", { timeout: 600_000 }, async () => {
    const dir = repo();
    try {
      holdLock(dir, process.pid);
      const run = await verify(dir, ["--no-queue"]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).queue, undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
