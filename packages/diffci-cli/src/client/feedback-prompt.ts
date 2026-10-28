import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { preferencePath, type TelemetryMode } from "./telemetry.js";

/** Interactive runs only; CI, agents and machine-readable output never see it. At most once a week. */
const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
type Flags = Record<string, string | boolean>;

function stampPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(preferencePath(env)), "feedback-prompt.json");
}

export function shouldShowFeedbackPrompt(flags: Flags, env: NodeJS.ProcessEnv, interactive: boolean, now = Date.now()): boolean {
  if (!interactive || flags.json === true || flags.quiet === true) return false;
  if (env.CI || env.GITHUB_ACTIONS || env.DIFFCI_MCP === "1" || env.DIFFCI_NO_FEEDBACK_PROMPT === "1") return false;
  try {
    const last = (JSON.parse(readFileSync(stampPath(env), "utf8")) as { shownAt?: number }).shownAt;
    if (typeof last === "number" && now - last < INTERVAL_MS) return false;
  } catch { /* Never shown, or unreadable: show it. */ }
  return true;
}

export function formatFeedbackPrompt(telemetry: TelemetryMode): string {
  const lines = [
    "",
    "Using DiffCI on a real repository? We read every reply:",
    "  tell us how it went: https://github.com/DiffCI/core/discussions",
    "  volunteer a pilot:   https://diffci.com/#pilot",
    "  star the engine:     https://github.com/DiffCI/core",
  ];
  if (telemetry === "off") lines.push("  share anonymous run counts: diffci telemetry --mode anonymous (no repository content)");
  lines.push("Shown at most weekly; DIFFCI_NO_FEEDBACK_PROMPT=1 hides it.");
  return lines.join("\n");
}

export function markFeedbackPromptShown(env: NodeJS.ProcessEnv, now = Date.now()): void {
  try {
    const path = stampPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ shownAt: now })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch { /* A read-only home only means the prompt may repeat. */ }
}
