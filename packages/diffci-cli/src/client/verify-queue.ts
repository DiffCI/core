import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { outcomeLogPath } from "./outcome-log.js";

/**
 * One `diffci verify` at a time per repository (2026-11-28, DiffCI/core#353).
 *
 * WHY. Several agent sessions share a checkout and each runs verify on its own. On DentalPresence two runs
 * started four minutes apart, CPU sat at 100%, and one was still in its gate checks after nine minutes,
 * where the checks alone take 3-6 minutes on a quiet machine. Same-tree reuse could not help: the second
 * run started before the first had written its outcome.
 *
 * WHAT. A lock file next to the outcome log (`<git common dir>/diffci/verify.lock`, shared by every
 * worktree) held from before the run until after its outcome is appended. A second run waits, says for
 * whom, and then starts; on the same tree it then finds the first run's pass and reuses it, so nothing
 * runs twice. A lock whose process is gone (same host, dead pid) is removed. After the queue timeout the
 * run goes ahead in parallel rather than never. `--no-queue` or DIFFCI_QUEUE=0 skips the queue.
 */

export interface VerifyLockHolder {
  pid: number;
  host: string;
  started_at: string;
  /** What the holder verifies (`--changed`, `--staged`, ...) and from which checkout. */
  scope: string;
  cwd: string;
  token: string;
}

export interface VerifyQueueOutcome {
  /** Time spent waiting for other runs; 0 when the lock was free. */
  queued_ms: number;
  /** The run this one waited for, when it waited. */
  waited_for?: Omit<VerifyLockHolder, "token">;
  /** True when the wait reached the queue timeout and this run went ahead in parallel. */
  timed_out?: boolean;
}

export interface VerifyLock extends VerifyQueueOutcome {
  release(): void;
}

export interface QueueOptions {
  scope: string;
  timeoutMs: number;
  pollMs?: number;
  /** Told once when the run starts waiting, and when it gives up waiting. */
  log?: (message: string) => void;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_QUEUE_TIMEOUT_MS = 15 * 60 * 1000;
/** A lock file that cannot be read yet may be mid-write; only after this long is it treated as abandoned. */
const UNREADABLE_GRACE_MS = 10_000;

export function verifyLockPath(repoPath: string): string | undefined {
  const log = outcomeLogPath(repoPath);
  return log ? join(dirname(log), "verify.lock") : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): VerifyLockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VerifyLockHolder>;
    return typeof parsed.pid === "number" && typeof parsed.token === "string" ? parsed as VerifyLockHolder : undefined;
  } catch {
    return undefined;
  }
}

function tryCreate(path: string, holder: VerifyLockHolder): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { writeSync(fd, JSON.stringify(holder)); } finally { closeSync(fd); }
  return true;
}

function removeIfStill(path: string, token: string | undefined): void {
  // Another run may have replaced a stale lock between the read and the unlink; never remove a live one.
  if (token !== undefined && readHolder(path)?.token !== token) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

const describe = (holder: Omit<VerifyLockHolder, "token">, now: number) =>
  `pid ${holder.pid}${holder.host !== hostname() ? ` on ${holder.host}` : ""}, ${holder.scope}, from ${holder.cwd}, running for ${Math.round((now - Date.parse(holder.started_at)) / 1000)}s`;

/** Waits for the repository's verify lock and takes it. Never throws: a lock that cannot be used runs unqueued. */
export async function acquireVerifyLock(repoPath: string, options: QueueOptions): Promise<VerifyLock> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const isAlive = options.isAlive ?? processAlive;
  const pollMs = options.pollMs ?? 1000;
  const unqueued = (fields: Omit<VerifyQueueOutcome, "queued_ms">, start: number): VerifyLock => ({ queued_ms: now() - start, ...fields, release() {} });
  const path = verifyLockPath(repoPath);
  if (!path) return { queued_ms: 0, release() {} };
  const start = now();
  const holder: VerifyLockHolder = { pid: process.pid, host: hostname(), started_at: new Date(start).toISOString(), scope: options.scope, cwd: repoPath, token: randomUUID() };
  let waitedFor: VerifyLockHolder | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    for (;;) {
      if (tryCreate(path, { ...holder, started_at: new Date(now()).toISOString() })) break;
      const current = readHolder(path);
      if (!current) {
        let age = 0;
        try { age = now() - statSync(path).mtimeMs; } catch { continue; }
        if (age > UNREADABLE_GRACE_MS) { removeIfStill(path, undefined); continue; }
      } else if (current.host === hostname() && !isAlive(current.pid)) {
        options.log?.(`diffci verify: removed a stale verify lock left by pid ${current.pid}, which is no longer running.`);
        removeIfStill(path, current.token);
        continue;
      } else if (waitedFor?.token !== current.token) {
        waitedFor = current;
        options.log?.(`diffci verify: waiting for another verify in this repository (${describe(current, now())}); --no-queue runs in parallel.`);
      }
      if (now() - start >= options.timeoutMs) {
        options.log?.(`diffci verify: still waiting after ${Math.round((now() - start) / 1000)}s; running in parallel with it.`);
        const { token: _token, ...shown } = waitedFor ?? current ?? holder;
        return unqueued({ ...(waitedFor ?? current ? { waited_for: shown } : {}), timed_out: true }, start);
      }
      await sleep(pollMs);
    }
  } catch {
    return unqueued({}, start);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    removeIfStill(path, holder.token);
  };
  // Ctrl-C or an uncaught error still frees the queue; a killed process leaves a lock the next run removes.
  process.once("exit", release);
  const queued = now() - start;
  if (waitedFor) {
    const { token: _token, ...shown } = waitedFor;
    return { queued_ms: queued, waited_for: shown, release };
  }
  return { queued_ms: queued, release };
}

/** The queue fields a receipt and the outcome log carry, or nothing when the run did not wait. */
export function queueField(lock: VerifyQueueOutcome): { queue?: VerifyQueueOutcome } {
  if (!lock.waited_for && !lock.timed_out) return {};
  const { queued_ms, waited_for, timed_out } = lock;
  return { queue: { queued_ms, ...(waited_for ? { waited_for } : {}), ...(timed_out ? { timed_out } : {}) } };
}
