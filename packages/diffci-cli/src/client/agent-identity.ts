/**
 * Which AI coding agent produced a change, when the person running DiffCI chooses to say so.
 *
 * Opt-in only. Nothing here runs unless `--agent <name>` / `DIFFCI_AGENT` is given; `--agent auto`
 * additionally checks a short list of marker variables the agents themselves set. Only the resulting
 * label is recorded - never a variable's value, never any other environment, never source.
 */

/** Agent identities DiffCI recognises. Anything else declared explicitly is "other". */
export const KNOWN_AGENTS = ["claude", "codex", "cursor", "copilot", "devin", "gemini", "aider", "jules", "openhands"] as const;
export type KnownAgent = (typeof KNOWN_AGENTS)[number];
export type AgentId = KnownAgent | "other";

export interface ObservationAgent {
  name: AgentId;
  /** `flag`: the caller named the agent. `environment`: `--agent auto` found exactly one marker. */
  source: "flag" | "environment";
}

const ALIASES: Record<string, KnownAgent> = {
  claude: "claude", "claude-code": "claude", claudecode: "claude", anthropic: "claude",
  codex: "codex", "codex-cli": "codex", "openai-codex": "codex", "chatgpt-codex": "codex",
  cursor: "cursor", "cursor-agent": "cursor", cursoragent: "cursor",
  copilot: "copilot", "github-copilot": "copilot", "copilot-swe-agent": "copilot",
  devin: "devin", "devin-ai": "devin",
  gemini: "gemini", "gemini-cli": "gemini", "gemini-code-assist": "gemini",
  aider: "aider", jules: "jules", "google-jules": "jules", openhands: "openhands", "all-hands": "openhands",
};
const NOT_AN_AGENT = new Set(["human", "none", "no", "false", "0"]);

/**
 * Normalises a declared agent name. `null` means "declared: no agent"; `undefined` means the value is
 * unusable and must be ignored. Unrecognised but well-formed names become "other" rather than being
 * stored verbatim, so a free-text field cannot grow the set of reported identities.
 */
export function normalizeDeclaredAgent(value: unknown): AgentId | null | undefined {
  const raw = typeof value === "string" ? value
    : value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name
      : undefined;
  if (raw === undefined) return undefined;
  const name = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!/^[a-z0-9][a-z0-9.-]{0,39}$/.test(name)) return undefined;
  if (NOT_AN_AGENT.has(name)) return null;
  return Object.hasOwn(ALIASES, name) ? ALIASES[name]! : "other";
}

/** Marker variables set by the agents' own shells. Presence is all that is read. */
const ENVIRONMENT_MARKERS: Array<[string, KnownAgent]> = [
  ["CLAUDECODE", "claude"],
  ["CURSOR_AGENT", "cursor"],
  ["CODEX_SANDBOX", "codex"],
  ["CODEX_SANDBOX_NETWORK_DISABLED", "codex"],
  ["GEMINI_CLI", "gemini"],
];

/** Exactly one agent's marker present, or nothing: two markers is ambiguity, never a guess. */
export function detectAgentFromEnvironment(env: Record<string, string | undefined>): KnownAgent | undefined {
  const found = new Set(ENVIRONMENT_MARKERS.filter(([key]) => (env[key] ?? "") !== "" && env[key] !== "0").map(([, agent]) => agent));
  return found.size === 1 ? [...found][0] : undefined;
}

/** Resolves `--agent` / `DIFFCI_AGENT`. Absent means the report carries no agent field at all. */
export function resolveObservationAgent(flag: string | boolean | undefined, env: Record<string, string | undefined>): ObservationAgent | undefined {
  const requested = typeof flag === "string" ? flag : env.DIFFCI_AGENT;
  if (!requested) return undefined;
  if (requested.trim().toLowerCase() === "auto") {
    const detected = detectAgentFromEnvironment(env);
    return detected ? { name: detected, source: "environment" } : undefined;
  }
  const name = normalizeDeclaredAgent(requested);
  return name ? { name, source: "flag" } : undefined;
}
