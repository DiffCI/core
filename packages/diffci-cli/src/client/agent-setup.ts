import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Which of the files init wrote or updated Git would leave out of a commit, from init's own result lines
 * ("wrote <path> ...", "updated <path> ..."). Paths under .git (the pre-push hook) are never versioned.
 *
 * WHY (2026-11-06). DentalPresence ignored all of `/.claude/`, so init reported "wrote
 * .claude/skills/diffci-verify/SKILL.md" for a skill no other checkout or agent session would ever get.
 */
export function ignoredWrites(repoPath: string, results: readonly string[]): string[] {
  const paths = results
    .map((result) => /^(?:wrote|updated) (\S+)/.exec(result)?.[1])
    .filter((path): path is string => path !== undefined && !path.startsWith(".git/"));
  if (paths.length === 0) return [];
  const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: repoPath,
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    windowsHide: true,
  });
  // Exit 1 means nothing is ignored; anything else (not a repository) leaves nothing to warn about.
  return result.status === 0 ? result.stdout.split("\0").filter(Boolean) : [];
}

/**
 * Agent integrations `diffci init` sets up by default (2026-11-04): the MCP server in the project
 * configs Claude Code (`.mcp.json`) and Cursor (`.cursor/mcp.json`) read, and the diffci-verify skill
 * in `.claude/skills`.
 *
 * WHY. Agents called DiffCI in 24 of over 1,500 test commands on DentalPresence, where it was only an
 * instruction. Growth depends on the agent finding DiffCI's tools in the repository without anyone
 * installing a plugin, so one `diffci init` now registers them. Each write keeps files and servers
 * DiffCI did not write.
 *
 * 2026-11-14: also the hyperscalers' coding agents. Kiro gets `.kiro/settings/mcp.json` (the read-only
 * tools auto-approved; it still asks before tests run) and `.kiro/skills`; Antigravity CLI gets
 * `.agents/mcp_config.json` and `.agents/skills`, which Codex reads too. GitHub Copilot needs no file of
 * its own for these: VS Code reads the root `.mcp.json`, and Copilot reads `.claude/skills`.
 */
export const MCP_CONFIG_PATHS = [".mcp.json", ".cursor/mcp.json", ".kiro/settings/mcp.json", ".agents/mcp_config.json"] as const;
export const SKILL_PATH = ".claude/skills/diffci-verify/SKILL.md";
export const SKILL_PATHS = [SKILL_PATH, ".agents/skills/diffci-verify/SKILL.md", ".kiro/skills/diffci-verify/SKILL.md"] as const;
const SKILL_AGENTS: Record<string, string> = {
  [SKILL_PATH]: "Claude Code and Copilot skill",
  ".agents/skills/diffci-verify/SKILL.md": "Antigravity CLI and Codex skill",
  ".kiro/skills/diffci-verify/SKILL.md": "Kiro skill",
};
/** MCP tools that only read the checkout; Kiro runs them without asking. */
export const KIRO_AUTO_APPROVE = ["diffci_changed_files", "diffci_select_tests", "diffci_explain_selection"] as const;

/** Same launcher as the portable agent plugin: `npx` through cmd.exe on Windows, where agents cannot spawn `npx.cmd` directly. */
export function mcpServerEntry(version: string): { command: string; args: string[] } {
  return {
    command: "node",
    args: [
      "-e",
      `const { spawn } = require('node:child_process'); const npxArgs = ['--yes', '--package', '@diffci.com/diffci@${version}', 'diffci-mcp']; const child = process.platform === 'win32' ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx', ...npxArgs], { stdio: 'inherit' }); child.once('error', (error) => { console.error('Failed to launch DiffCI MCP:', error.message); process.exit(1); }); child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));`,
    ],
  };
}

function isDiffciEntry(entry: unknown): boolean {
  return JSON.stringify(entry ?? null).includes("@diffci.com/diffci");
}

/** Adds or updates the `diffci` server and leaves every other server untouched. */
export function writeMcpConfig(repoPath: string, relativePath: string, version: string, force: boolean): string {
  const absolutePath = join(repoPath, relativePath);
  const entry: Record<string, unknown> = mcpServerEntry(version);
  if (relativePath === ".kiro/settings/mcp.json") entry.autoApprove = [...KIRO_AUTO_APPROVE];
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  let existing: string | undefined;
  if (existsSync(absolutePath)) {
    existing = readFileSync(absolutePath, "utf8");
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as typeof config;
    } catch {
      return `kept ${relativePath} (not a JSON object; add the diffci MCP server by hand)`;
    }
  }
  const servers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  if (servers.diffci !== undefined && !isDiffciEntry(servers.diffci) && !force) {
    return `kept ${relativePath} (its diffci server was not written by DiffCI; pass --force to replace it)`;
  }
  config.mcpServers = { ...servers, diffci: entry };
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (next === existing) return `kept ${relativePath} (diffci MCP server current)`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, next, "utf8");
  return `${existing === undefined ? "wrote" : "updated"} ${relativePath} (diffci MCP server)`;
}

/** Kept identical to integrations/agent-plugin/skills/diffci-verify/SKILL.md (tested). */
export const DIFFCI_VERIFY_SKILL = `---
name: diffci-verify
description: Verify an agent's change before reporting it ready: run the tests and checks it affects with DiffCI MCP tools or the DiffCI CLI, falling back to the full suite when unsure.
---

Pass the absolute path of the edited repository as \`repo\` on every tool call.

Use \`diffci_changed_files\` to inspect staged, unstaged, and non-ignored untracked
changes. Use \`diffci_select_tests\` or \`diffci_explain_selection\` when you need the
affected-test plan, command, or reasons for full fallback. These tools run no tests;
their counts describe test files, not passing test cases. A plan is not verification.

Before reporting an edited change ready, call \`diffci_run_affected_tests\`. It
recomputes the selection and verifies the current snapshot. Accept a passing result
only when \`safe_to_continue\` is true and \`snapshot.unchanged\` is true. After further
edits, rerun verification. For a clean committed change, use \`diffci_verify\` with the
intended base/head range instead; no uncommitted changes does not mean the commit
has been tested.

If MCP is unavailable, use the installed CLI:

\`\`\`bash
diffci verify --changed --repo /absolute/path/to/repository --json
\`\`\`

If DiffCI is not installed, use \`npx "@diffci.com/diffci@latest" verify --changed\`
with the same repo and JSON flags. On blocked analysis or installation failure,
run the repository's normal verification and report the limitation. On a test
failure, fix the cause and rerun. On snapshot changes from generated files, inspect
the files and rerun for that snapshot.

Report executed command, selection scope (affected or full fallback), test-file
counts, outcome, and any outstanding required checks. Never infer passed suites,
test cases, skipped CI jobs, or measured savings from selection counts. Required
project CI stays authoritative.
`;

/**
 * Stop hooks that run `diffci agent-stop` when the agent ends a turn (agent-stop.ts, 2026-11-06), in each
 * agent's project hook file. Claude Code and Codex share one shape (`Stop` > group > handlers); Cursor has
 * its own (`version: 1`, `stop` > handlers). A hook is DiffCI's when its command runs `agent-stop` from
 * the DiffCI package; those are replaced, every other hook is kept.
 *
 * GitHub Copilot (2026-11-14): `agentStop` in `.github/hooks/diffci.json` (`version: 1`, handlers with
 * `bash` and `powershell` commands), read by Copilot CLI, the cloud agent and VS Code. Its documented
 * `{"decision": "block", "reason"}` output forces another turn. Kiro has no hook here: its `Stop`
 * trigger is documented as unable to block, so it could not make the agent fix a failure.
 */
export type SetupHookAgent = "claude" | "codex" | "cursor" | "copilot";
export const AGENT_HOOK_PATHS: Record<SetupHookAgent, string> = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
  cursor: ".cursor/hooks.json",
  copilot: ".github/hooks/diffci.json",
};
/** Seconds the agent waits for the hook; verify's own timeout stays below it (cli.ts, agent-stop). */
export const AGENT_HOOK_TIMEOUT_SECONDS = 1200;

function isDiffciHook(command: unknown): boolean {
  return typeof command === "string" && /\bagent-stop\b/.test(command) && /diffci/.test(command);
}

export function writeAgentStopHook(repoPath: string, agent: SetupHookAgent, launcher: string): string {
  const relativePath = AGENT_HOOK_PATHS[agent];
  const absolutePath = join(repoPath, relativePath);
  const command = `${launcher} agent-stop --agent ${agent}`;
  let config: Record<string, unknown> = {};
  let existing: string | undefined;
  if (existsSync(absolutePath)) {
    existing = readFileSync(absolutePath, "utf8");
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      return `kept ${relativePath} (not a JSON object; add the DiffCI stop hook by hand)`;
    }
  }
  const hooks = config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? config.hooks as Record<string, unknown> : {};
  if (agent === "cursor") {
    const stop = Array.isArray(hooks.stop) ? hooks.stop.filter((entry) => !isDiffciHook((entry as { command?: unknown })?.command)) : [];
    config = { ...config, version: typeof config.version === "number" ? config.version : 1, hooks: { ...hooks, stop: [...stop, { command, loop_limit: 3 }] } };
  } else if (agent === "copilot") {
    const ours = (entry: unknown) => ["bash", "powershell", "command"].some((key) => isDiffciHook((entry as Record<string, unknown> | null)?.[key]));
    const stop = Array.isArray(hooks.agentStop) ? hooks.agentStop.filter((entry) => !ours(entry)) : [];
    config = {
      ...config,
      version: typeof config.version === "number" ? config.version : 1,
      hooks: { ...hooks, agentStop: [...stop, { type: "command", bash: command, powershell: command, timeoutSec: AGENT_HOOK_TIMEOUT_SECONDS }] },
    };
  } else {
    const groups = (Array.isArray(hooks.Stop) ? hooks.Stop : []).flatMap((group) => {
      const handlers = Array.isArray((group as { hooks?: unknown })?.hooks) ? (group as { hooks: unknown[] }).hooks : [];
      const kept = handlers.filter((handler) => !isDiffciHook((handler as { command?: unknown })?.command));
      return kept.length === 0 && handlers.length > 0 ? [] : [kept.length === handlers.length ? group : { ...(group as object), hooks: kept }];
    });
    config = { ...config, hooks: { ...hooks, Stop: [...groups, { hooks: [{ type: "command", command, timeout: AGENT_HOOK_TIMEOUT_SECONDS }] }] } };
  }
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (next === existing) return `kept ${relativePath} (DiffCI stop hook current)`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, next, "utf8");
  return `${existing === undefined ? "wrote" : "updated"} ${relativePath} (DiffCI stop hook)`;
}

/** A skill file DiffCI wrote is recognised by its frontmatter name and updated; any other file is kept. */
export function writeSkill(repoPath: string, force: boolean, relativePath: string = SKILL_PATH): string {
  const absolutePath = join(repoPath, relativePath);
  if (existsSync(absolutePath)) {
    const existing = readFileSync(absolutePath, "utf8");
    if (existing.replace(/\r\n/g, "\n") === DIFFCI_VERIFY_SKILL) return `kept ${relativePath} (current)`;
    if (!/^---\r?\nname: diffci-verify\r?\n/.test(existing) && !force) {
      return `kept ${relativePath} (existing file not written by DiffCI; pass --force to replace it)`;
    }
    writeFileSync(absolutePath, DIFFCI_VERIFY_SKILL, "utf8");
    return `updated ${relativePath}`;
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, DIFFCI_VERIFY_SKILL, "utf8");
  return `wrote ${relativePath} (${SKILL_AGENTS[relativePath] ?? "skill"})`;
}
