import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deliverUsageSignal, type UsageCommand, type UsageOutcome } from "./usage-signal.js";

export type TelemetryMode = "off" | "anonymous" | "installations";
interface Preference { mode: TelemetryMode; installationId?: string; internal: boolean }
type Flags = Record<string, string | boolean>;

export function preferencePath(env: NodeJS.ProcessEnv): string {
  return join(env.DIFFCI_TELEMETRY_HOME ?? join(homedir(), ".diffci"), "telemetry.json");
}

export function readTelemetryPreference(env: NodeJS.ProcessEnv): Preference {
  try {
    const value = JSON.parse(readFileSync(preferencePath(env), "utf8")) as Preference;
    if (!["off", "anonymous", "installations"].includes(value.mode)) throw new Error("invalid preference");
    if (value.mode === "installations" && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.installationId ?? "")) throw new Error("invalid identifier");
    return { mode: value.mode, internal: value.internal === true, ...(value.mode === "installations" ? { installationId: value.installationId } : {}) };
  } catch { return { mode: "off", internal: false }; }
}

export function configureTelemetry(mode: string, internal: boolean, env: NodeJS.ProcessEnv): Preference {
  if (!["off", "anonymous", "installations"].includes(mode)) throw new Error("Choose off, anonymous, or installations.");
  const previous = readTelemetryPreference(env);
  const value: Preference = { mode: mode as TelemetryMode, internal,
    ...(mode === "installations" ? { installationId: previous.installationId ?? randomUUID() } : {}) };
  const path = preferencePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  return value;
}

export async function recordUsage(command: UsageCommand, outcome: UsageOutcome, version: string, flags: Flags, env: NodeJS.ProcessEnv): Promise<void> {
  // Explicit denial overrides saved consent and every opt-in route.
  if (flags["no-send"] === true || env.DIFFCI_SHARE_USAGE === "0" || env.DIFFCI_NO_SEND === "1") return;
  const preference = readTelemetryPreference(env);
  if (flags["share-usage"] !== true && env.DIFFCI_SHARE_USAGE !== "1" && preference.mode === "off") return;
  const result = await deliverUsageSignal({ command, outcome, version,
    surface: env.DIFFCI_MCP === "1" ? "local-mcp" : "cli",
    activity: flags["internal-usage"] === true || env.DIFFCI_USAGE_INTERNAL === "1" || preference.internal ? "internal" : "external",
    ...(preference.mode === "installations" ? { installationId: preference.installationId } : {}),
  });
  console.error(`DiffCI telemetry: ${result.status}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}. No repository content sent.`);
}
