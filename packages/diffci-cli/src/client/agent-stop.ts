import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { outcomeLogPath } from "./outcome-log.js";
import type { VerificationReport } from "./verify.js";

/**
 * Verify when an agent finishes a turn (2026-11-06).
 *
 * WHY. Agents called DiffCI in 24 of over 1,500 test commands on DentalPresence. An instruction to run
 * verify is advice an agent can skip; a hook on the end of its turn is not. The agent finds out what its
 * change broke before it tells anyone the work is done.
 *
 * WHAT. `diffci agent-stop --agent claude|codex|cursor` is the command the agent's stop hook runs
 * (Claude Code `Stop` in .claude/settings.json, Codex `Stop` in .codex/hooks.json, Cursor `stop` in
 * .cursor/hooks.json; `diffci init` installs them). It reads the hook's JSON from stdin, verifies the
 * uncommitted changes, and:
 *   - passes quietly when nothing changed or verification passed;
 *   - when tests or checks fail, asks the agent to continue with the failures as the reason (Claude Code
 *     and Codex: `{"decision": "block", "reason"}`; Cursor: `{"followup_message"}`);
 *   - never holds the agent when verification could not run (blocked analysis, no command): that is
 *     reported to the person, not turned into work for the agent;
 *   - hands back to the person after DIFFCI_AGENT_HOOK_MAX failed attempts in one session (default 3),
 *     counted in .git/diffci/agent-hook.json and reset by a pass, on top of the agents' own loop limits.
 * DIFFCI_AGENT_HOOK=0 turns it off. Repeats on an unchanged tree are instant through result reuse.
 */

export type HookAgent = "claude" | "codex" | "cursor";
export const HOOK_AGENTS: readonly HookAgent[] = ["claude", "codex", "cursor"];
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface StopPayload {
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  stop_hook_active?: boolean;
  loop_count?: number;
  status?: string;
}

export function parseStopPayload(text: string): StopPayload {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as StopPayload : {};
  } catch {
    return {};
  }
}

/** The repository the agent worked in: the top level of the hook's cwd, the agent's project directory, or ours. */
export function stopRepoPath(payload: StopPayload, env: Record<string, string | undefined>, fallback: string): string {
  const start = payload.cwd ?? payload.workspace_roots?.[0] ?? env.CLAUDE_PROJECT_DIR ?? env.CURSOR_PROJECT_DIR ?? fallback;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || start;
  } catch {
    return start;
  }
}

function sessionKey(payload: StopPayload): string {
  return payload.session_id ?? payload.conversation_id ?? "unknown";
}

function attemptsPath(repoPath: string): string | undefined {
  const log = outcomeLogPath(repoPath);
  return log ? join(dirname(log), "agent-hook.json") : undefined;
}

type AttemptLog = Record<string, { failures: number; at: string }>;

function readAttempts(path: string | undefined): AttemptLog {
  if (!path || !existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as AttemptLog; } catch { return {}; }
}

/** Failed attempts so far in this session, and a writer for the new count (sessions older than a day are dropped). */
export function sessionAttempts(repoPath: string, payload: StopPayload): { failures: number; record(failures: number): void } {
  const path = attemptsPath(repoPath);
  const key = sessionKey(payload);
  const log = readAttempts(path);
  return {
    failures: log[key]?.failures ?? 0,
    record(failures: number) {
      if (!path) return;
      const now = Date.now();
      const kept = Object.fromEntries(Object.entries(log).filter(([id, entry]) => id !== key && now - Date.parse(entry.at) < 24 * 60 * 60 * 1000));
      const next: AttemptLog = failures > 0 ? { ...kept, [key]: { failures, at: new Date(now).toISOString() } } : kept;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(next)}\n`, "utf8");
      } catch {}
    },
  };
}

export interface StopDecision {
  /** What the hook prints on stdout (always JSON: Codex rejects plain text on exit 0). */
  stdout: string;
  /** Failed attempts to record for the session after this decision. */
  failures: number;
}

function failureReason(report: VerificationReport, attempt: number, max: number): string {
  const failing = report.execution?.failingTests ?? [];
  const lines = [
    `DiffCI verified your uncommitted changes and they fail (attempt ${attempt} of ${max} this session): ${report.reason}.`,
    ...(failing.length ? [`Failing tests: ${failing.slice(0, 10).join("; ")}${failing.length > 10 ? `; and ${failing.length - 10} more` : ""}.`] : []),
    ...(report.command ? [`DiffCI ran: ${report.command}`] : []),
    "Fix what broke, then finish. DiffCI verifies again when you stop; `diffci verify --changed` reproduces this run.",
  ];
  return lines.join("\n");
}

/**
 * The hook's answer for one verification. `report` is undefined when nothing could be verified at all.
 */
export function decideStop(agent: HookAgent, report: VerificationReport | undefined, failuresSoFar: number, max: number): StopDecision {
  const allow = (message?: string): StopDecision => ({
    stdout: JSON.stringify(message && agent !== "cursor" ? { systemMessage: message } : {}),
    failures: 0,
  });
  if (!report) return allow("DiffCI could not verify this turn's changes.");
  if (report.verification === "passed") return { ...allow(), failures: 0 };
  if (report.verification === "blocked") {
    return { ...allow(`DiffCI could not verify this turn's changes: ${report.reason}`), failures: failuresSoFar };
  }
  if (failuresSoFar >= max) {
    return { ...allow(`DiffCI verification still fails after ${max} attempt(s) this session; over to you: ${report.reason}`), failures: failuresSoFar };
  }
  const reason = failureReason(report, failuresSoFar + 1, max);
  return {
    stdout: JSON.stringify(agent === "cursor" ? { followup_message: reason } : { decision: "block", reason }),
    failures: failuresSoFar + 1,
  };
}

export function maxAttempts(env: Record<string, string | undefined>): number {
  const value = Number(env.DIFFCI_AGENT_HOOK_MAX);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_ATTEMPTS;
}
