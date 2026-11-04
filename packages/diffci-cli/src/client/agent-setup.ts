import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Agent integrations `diffci init` sets up by default (2026-11-04): the MCP server in the project
 * configs Claude Code (`.mcp.json`) and Cursor (`.cursor/mcp.json`) read, and the diffci-verify skill
 * in `.claude/skills`.
 *
 * WHY. Agents called DiffCI in 24 of over 1,500 test commands on DentalPresence, where it was only an
 * instruction. Growth depends on the agent finding DiffCI's tools in the repository without anyone
 * installing a plugin, so one `diffci init` now registers them. Each write keeps files and servers
 * DiffCI did not write.
 */
export const MCP_CONFIG_PATHS = [".mcp.json", ".cursor/mcp.json"] as const;
export const SKILL_PATH = ".claude/skills/diffci-verify/SKILL.md";

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
  const entry = mcpServerEntry(version);
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
description: Select and verify affected tests after editing code in a local Git repository, using DiffCI MCP tools or the DiffCI CLI before reporting the change ready.
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

/** A skill file DiffCI wrote is recognised by its frontmatter name and updated; any other file is kept. */
export function writeSkill(repoPath: string, force: boolean): string {
  const absolutePath = join(repoPath, SKILL_PATH);
  if (existsSync(absolutePath)) {
    const existing = readFileSync(absolutePath, "utf8");
    if (existing.replace(/\r\n/g, "\n") === DIFFCI_VERIFY_SKILL) return `kept ${SKILL_PATH} (current)`;
    if (!/^---\r?\nname: diffci-verify\r?\n/.test(existing) && !force) {
      return `kept ${SKILL_PATH} (existing file not written by DiffCI; pass --force to replace it)`;
    }
    writeFileSync(absolutePath, DIFFCI_VERIFY_SKILL, "utf8");
    return `updated ${SKILL_PATH}`;
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, DIFFCI_VERIFY_SKILL, "utf8");
  return `wrote ${SKILL_PATH} (Claude Code skill)`;
}
