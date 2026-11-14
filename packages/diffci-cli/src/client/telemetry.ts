import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deliverUsageSignal, type UsageCommand, type UsageOutcome, type UsageSurface } from "./usage-signal.js";

/**
 * Usage counting is on by default. "repo" (the default) also names the repository (host/owner/repo from
 * the Git remote); "count-only" drops the name. Only DO_NOT_TRACK=1, DIFFCI_NO_SEND=1 or
 * DIFFCI_SHARE_USAGE=0 stop the count. No repository content, paths, commits or machine details are sent.
 */
export type TelemetryMode = "repo" | "count-only";
interface Preference { mode: TelemetryMode; installationId?: string; internal: boolean; noticeShown: boolean }
type Flags = Record<string, string | boolean>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TELEMETRY_DOCS = "https://github.com/DiffCI/core/blob/main/docs/telemetry.md";

export function preferencePath(env: NodeJS.ProcessEnv): string {
  return join(env.DIFFCI_TELEMETRY_HOME ?? join(homedir(), ".diffci"), "telemetry.json");
}

/** Older saved choices: off and anonymous never shared more than a count, so they keep the name out. */
function normaliseMode(mode: unknown): TelemetryMode | undefined {
  if (mode === "repo" || mode === "installations") return "repo";
  if (mode === "count-only" || mode === "anonymous" || mode === "off") return "count-only";
  return undefined;
}

export function readTelemetryPreference(env: NodeJS.ProcessEnv): Preference {
  try {
    const value = JSON.parse(readFileSync(preferencePath(env), "utf8")) as Record<string, unknown>;
    const mode = normaliseMode(value.mode);
    if (!mode) throw new Error("invalid preference");
    const installationId = typeof value.installationId === "string" && UUID.test(value.installationId) ? value.installationId : undefined;
    return { mode, internal: value.internal === true, noticeShown: value.noticeShown === true,
      ...(mode === "repo" && installationId ? { installationId } : {}) };
  } catch { return { mode: "repo", internal: false, noticeShown: false }; }
}

function writePreference(value: Preference, env: NodeJS.ProcessEnv): void {
  const path = preferencePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function configureTelemetry(mode: string, internal: boolean, env: NodeJS.ProcessEnv): Preference {
  const normalised = normaliseMode(mode);
  if (!normalised) throw new Error("Choose repo or count-only. DO_NOT_TRACK=1 stops usage counting.");
  const previous = readTelemetryPreference(env);
  const value: Preference = { mode: normalised, internal, noticeShown: true,
    ...(normalised === "repo" ? { installationId: previous.installationId ?? randomUUID() } : {}) };
  writePreference(value, env);
  return value;
}

/** True when the environment turns usage counting off entirely. Flags cannot: only the environment can. */
export function usageCountingDisabled(env: NodeJS.ProcessEnv): boolean {
  const on = (value: string | undefined) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return on(env.DO_NOT_TRACK) || env.DIFFCI_NO_SEND === "1" || env.DIFFCI_SHARE_USAGE === "0";
}

/** host/owner/repo from a Git remote URL, without credentials, scheme or .git; undefined if unrecognised. */
export function normaliseRemote(remote: string): string | undefined {
  let value = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const url = new URL(value);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
      value = `${url.hostname}${url.pathname}`;
    } catch { return undefined; }
  }
  value = value.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9.-]+(\/[\w.-]+){2,5}$/.test(value) && value.length <= 200 ? value : undefined;
}

export function repositoryName(repoPath: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_REPOSITORY && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) {
    let host = "github.com";
    try { if (env.GITHUB_SERVER_URL) host = new URL(env.GITHUB_SERVER_URL).hostname; } catch { /* keep github.com */ }
    return normaliseRemote(`https://${host}/${env.GITHUB_REPOSITORY}`);
  }
  if (env.CI_SERVER_HOST && env.CI_PROJECT_PATH) return normaliseRemote(`https://${env.CI_SERVER_HOST}/${env.CI_PROJECT_PATH}`);
  if (!repoPath) return undefined;
  try {
    const remote = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return normaliseRemote(remote);
  } catch { return undefined; }
}

function surfaceOf(env: NodeJS.ProcessEnv): UsageSurface {
  if (env.DIFFCI_MCP === "1") return "local-mcp";
  if (env.DIFFCI_SURFACE === "github-action" || env.DIFFCI_SURFACE === "gitlab-component") return env.DIFFCI_SURFACE;
  return "cli";
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI && env.CI !== "false" && env.CI !== "0") || Boolean(env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.CIRCLECI);
}

export function telemetryNotice(mode: TelemetryMode): string {
  return mode === "repo"
    ? `DiffCI counts runs with this repository's name (host/owner/repo), never its content. \`diffci telemetry --mode count-only\` drops the name; DO_NOT_TRACK=1 stops counting. ${TELEMETRY_DOCS}`
    : `DiffCI counts runs without repository names or content. DO_NOT_TRACK=1 stops counting. ${TELEMETRY_DOCS}`;
}

/** Best effort: never throws and never changes the exit code. `flags` are read for --internal-usage only. */
export async function recordUsage(command: UsageCommand, outcome: UsageOutcome, version: string, flags: Flags, env: NodeJS.ProcessEnv, repoPath?: string): Promise<void> {
  try {
    if (usageCountingDisabled(env)) return;
    const preference = readTelemetryPreference(env);
    if (!preference.noticeShown) {
      console.error(telemetryNotice(preference.mode));
      try { writePreference({ ...preference, noticeShown: true }, env); } catch { /* read-only home: show it again next time */ }
    }
    const repository = preference.mode === "repo" ? repositoryName(repoPath, env) : undefined;
    await deliverUsageSignal({ command, outcome, version,
      surface: surfaceOf(env),
      ci: isCi(env),
      activity: flags["internal-usage"] === true || env.DIFFCI_USAGE_INTERNAL === "1" || preference.internal ? "internal" : "external",
      ...(preference.installationId ? { installationId: preference.installationId } : {}),
      ...(repository ? { repository } : {}),
    });
  } catch { /* usage counting never affects a run */ }
}
