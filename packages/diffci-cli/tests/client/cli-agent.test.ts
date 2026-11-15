import { strict as assert } from "node:assert";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd, encoding: "utf8", env });
}

describe("agent-facing CLI commands", () => {
  it("prints check and init as first-class commands", () => {
    const result = runCli(["help"], ROOT);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /diffci init \[--repo <path>\] \[--workflow\] \[--verification-workflow\] \[--install\] \[--no-hook\] \[--no-mcp\] \[--no-skill\]\s+\[--no-agent-hooks\] \[--force\]/);
    assert.match(result.stdout, /diffci agent-stop --agent claude\|codex\|cursor/);
    assert.match(result.stdout, /diffci mcp/);
    assert.match(result.stdout, /diffci verify \[--changed \| --base <sha> --head <sha>\]/);
    assert.match(result.stdout, /diffci check \[--repo <path>\]/);
    assert.match(result.stdout, /check analyzes the change, runs inferred full and selected commands/);
  });

  it("initializes AI-agent instruction files without overwriting existing files by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-init-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Existing agent policy\n", "utf8");

      const result = runCli(["init", "--repo", dir, "--workflow", "--verification-workflow"], ROOT);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /updated AGENTS\.md \(DiffCI managed section\)/);
      assert.match(result.stdout, /wrote CLAUDE\.md/);
      assert.match(result.stdout, /wrote \.github\/workflows\/diffci\.yml/);
      assert.match(result.stdout, /wrote \.github\/workflows\/diffci-verify\.yml/);
      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      assert.match(agents, /^# Existing agent policy/);
      assert.match(agents, /<!-- diffci:managed:start -->/);
      assert.match(agents, /verify --changed --json/);
      assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /npx "@diffci\.com\/diffci@latest" verify --changed --json/);
      assert.match(readFileSync(join(dir, ".cursor", "rules", "diffci.mdc"), "utf8"), /alwaysApply: true/);
      assert.match(readFileSync(join(dir, ".github", "copilot-instructions.md"), "utf8"), /Repository CI\/CD Validation/);
      const config = JSON.parse(readFileSync(join(dir, "diffci.config.json"), "utf8")) as { agentDefaultCommand?: string; mode?: string; sendReports?: boolean };
      assert.equal(config.agentDefaultCommand, 'npx "@diffci.com/diffci@latest" verify --changed --json');
      assert.equal(config.mode, "verify-changed");
      assert.equal(config.sendReports, false);
      assert.match(readFileSync(join(dir, ".github", "workflows", "diffci.yml"), "utf8"), new RegExp(`npx "@diffci\\.com/diffci@${PACKAGE_VERSION.replaceAll(".", "\\.")}" observe --no-send`));
      const verificationWorkflow = readFileSync(join(dir, ".github", "workflows", "diffci-verify.yml"), "utf8");
      assert.match(verificationWorkflow, new RegExp(`npx "@diffci\\.com/diffci@${PACKAGE_VERSION.replaceAll(".", "\\.")}" verify --json`));
      assert.match(verificationWorkflow, /fetch-depth: 0/);
      assert.match(verificationWorkflow, /github\.event\.pull_request\.head\.sha \|\| github\.sha/);
      assert.match(verificationWorkflow, /actions\/upload-artifact@[0-9a-f]{40} # immutable upload-artifact v7 pin/);
      assert.doesNotMatch(verificationWorkflow, /continue-on-error/);
      const workflowCheck = runCli(["verify-workflow", "--repo", dir], ROOT);
      assert.equal(workflowCheck.status, 0, workflowCheck.stdout + workflowCheck.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create a workflow unless requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-no-workflow-"));
    try {
      const result = runCli(["init", "--repo", dir], ROOT);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /skipped \.github\/workflows\/diffci\.yml/);
      assert.match(result.stdout, /skipped package installation/);
      assert.equal(existsSync(join(dir, ".github", "workflows", "diffci.yml")), false);
      assert.equal(existsSync(join(dir, ".github", "workflows", "diffci-verify.yml")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets up the MCP server, skill and pre-push hook by default, keeping what DiffCI did not write", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-setup-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify({ mcpServers: { other: { command: "other-server" } } })}\n`, "utf8");

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = runCli(["init", "--repo", dir], ROOT);
        assert.equal(result.status, 0, result.stderr);
        if (attempt === 0) {
          assert.match(result.stdout, /updated \.mcp\.json \(diffci MCP server\)/);
          assert.match(result.stdout, /wrote \.cursor\/mcp\.json \(diffci MCP server\)/);
          assert.match(result.stdout, /wrote \.kiro\/settings\/mcp\.json \(diffci MCP server\)/);
          assert.match(result.stdout, /wrote \.agents\/mcp_config\.json \(diffci MCP server\)/);
          assert.match(result.stdout, /wrote \.claude\/skills\/diffci-verify\/SKILL\.md/);
          assert.match(result.stdout, /wrote \.agents\/skills\/diffci-verify\/SKILL\.md \(Antigravity CLI and Codex skill\)/);
          assert.match(result.stdout, /wrote \.kiro\/skills\/diffci-verify\/SKILL\.md \(Kiro skill\)/);
          assert.match(result.stdout, /wrote \.github\/hooks\/diffci\.json \(DiffCI stop hook\)/);
          assert.match(result.stdout, /wrote \.git\/hooks\/pre-push/);
        } else {
          assert.match(result.stdout, /kept \.mcp\.json \(diffci MCP server current\)/);
          assert.match(result.stdout, /kept \.claude\/skills\/diffci-verify\/SKILL\.md \(current\)/);
          assert.doesNotMatch(result.stdout, /^ {2}(?:wrote|updated) (?!AGENTS|CLAUDE|\.github\/copilot)/m, "a second init rewrites no agent integration");
        }
      }

      const claudeConfig = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args?: string[] }> };
      assert.deepEqual(claudeConfig.mcpServers.other, { command: "other-server" });
      assert.equal(claudeConfig.mcpServers.diffci?.command, "node");
      assert.match(claudeConfig.mcpServers.diffci?.args?.[1] ?? "", new RegExp(`'@diffci\\.com/diffci@${PACKAGE_VERSION.replaceAll(".", "\\.")}', 'diffci-mcp'`));
      const pluginConfig = JSON.parse(readFileSync(join(ROOT, "..", "..", "integrations", "agent-plugin", ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
      assert.deepEqual(JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")), pluginConfig, "init must launch MCP exactly like the portable plugin");
      const pluginSkill = readFileSync(join(ROOT, "..", "..", "integrations", "agent-plugin", "skills", "diffci-verify", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
      for (const skillDir of [".claude", ".agents", ".kiro"]) assert.equal(readFileSync(join(dir, skillDir, "skills", "diffci-verify", "SKILL.md"), "utf8"), pluginSkill);
      // Kiro auto-approves the read-only tools only; Antigravity CLI takes the plain entry.
      const kiro = JSON.parse(readFileSync(join(dir, ".kiro", "settings", "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
      assert.deepEqual(kiro.mcpServers.diffci, { ...(pluginConfig.mcpServers.diffci as object), autoApprove: ["diffci_changed_files", "diffci_select_tests", "diffci_explain_selection"] });
      assert.deepEqual(JSON.parse(readFileSync(join(dir, ".agents", "mcp_config.json"), "utf8")), pluginConfig);
      assert.match(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8"), /diffci:managed pre-push hook/);
      // Stop hooks for Claude Code, Codex and Cursor run diffci agent-stop when the agent ends a turn.
      assert.match(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).hooks.Stop[0].hooks[0].command, /diffci.* agent-stop --agent claude$/);
      assert.match(JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8")).hooks.Stop[0].hooks[0].command, /agent-stop --agent codex$/);
      assert.match(JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8")).hooks.stop[0].command, /agent-stop --agent cursor$/);
      assert.match(JSON.parse(readFileSync(join(dir, ".github", "hooks", "diffci.json"), "utf8")).hooks.agentStop[0].bash, /agent-stop --agent copilot$/);
      assert.equal(existsSync(join(dir, ".kiro", "hooks")), false, "Kiro's Stop hook cannot block, so init adds none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out each agent integration on request and keeps a foreign diffci server", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-opt-out-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      mkdirSync(join(dir, ".cursor"));
      const foreign = `${JSON.stringify({ mcpServers: { diffci: { command: "my-own-diffci" } } })}\n`;
      writeFileSync(join(dir, ".cursor", "mcp.json"), foreign, "utf8");

      const kept = runCli(["init", "--repo", dir, "--no-skill", "--no-hook"], ROOT);
      assert.equal(kept.status, 0, kept.stderr);
      assert.match(kept.stdout, /kept \.cursor\/mcp\.json \(its diffci server was not written by DiffCI/);
      assert.equal(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8"), foreign);
      assert.match(kept.stdout, /skipped the pre-push hook \(--no-hook\)/);
      assert.match(kept.stdout, /skipped the diffci-verify skills \(--no-skill\)/);
      for (const skillDir of [".claude", ".agents", ".kiro"]) assert.equal(existsSync(join(dir, skillDir, "skills")), false);
      assert.ok(existsSync(join(dir, ".kiro", "settings", "mcp.json")));
      assert.equal(existsSync(join(dir, ".git", "hooks", "pre-push")), false);

      for (const path of [".mcp.json", ".kiro", ".agents", ".github"]) rmSync(join(dir, path), { recursive: true, force: true });
      const noMcp = runCli(["init", "--repo", dir, "--no-mcp", "--no-hook", "--no-agent-hooks"], ROOT);
      assert.equal(noMcp.status, 0, noMcp.stderr);
      assert.match(noMcp.stdout, /skipped the MCP server configs \(--no-mcp\)/);
      assert.match(noMcp.stdout, /skipped the agent stop hooks \(--no-agent-hooks\)/);
      assert.equal(existsSync(join(dir, ".mcp.json")), false);
      assert.equal(existsSync(join(dir, ".kiro", "settings", "mcp.json")), false);
      assert.equal(existsSync(join(dir, ".agents", "mcp_config.json")), false);
      assert.equal(existsSync(join(dir, ".github", "hooks")), false);
      assert.ok(existsSync(join(dir, ".agents", "skills", "diffci-verify", "SKILL.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when .gitignore would keep the files it wrote out of commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-agent-ignored-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      writeFileSync(join(dir, ".gitignore"), "/.claude/\n/.kiro/\n", "utf8");

      const result = runCli(["init", "--repo", dir], ROOT);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Warning: \.gitignore keeps these files out of commits/);
      assert.match(result.stdout, /^ {2}\.claude\/skills\/diffci-verify\/SKILL\.md$/m);
      assert.match(result.stdout, /^ {2}\.claude\/settings\.json$/m);
      assert.match(result.stdout, /^ {2}\.kiro\/settings\/mcp\.json$/m);
      assert.match(result.stdout, /^ {2}\.kiro\/skills\/diffci-verify\/SKILL\.md$/m);
      assert.doesNotMatch(result.stdout, /^ {2}\.agents\/mcp_config\.json$/m);
      assert.doesNotMatch(result.stdout, /^ {2}\.mcp\.json$/m);
      assert.doesNotMatch(result.stdout, /^ {2}\.git\/hooks\/pre-push$/m);

      writeFileSync(join(dir, ".gitignore"), "/.claude/*\n!/.claude/skills/\n!/.claude/settings.json\n/.kiro/*\n!/.kiro/settings/\n!/.kiro/skills/\n", "utf8");
      const clean = runCli(["init", "--repo", dir], ROOT);
      assert.equal(clean.status, 0, clean.stderr);
      assert.doesNotMatch(clean.stdout, /Warning: \.gitignore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initializes an installed npm project end to end and is idempotent", () => {
    const parent = mkdtempSync(join(tmpdir(), "diffci-cli-install-"));
    const packageDir = join(parent, "package");
    const consumerDir = join(parent, "consumer");
    const shimDir = join(parent, "shim");
    mkdirSync(packageDir);
    mkdirSync(consumerDir);
    mkdirSync(shimDir);
    try {
      writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "@diffci.com/diffci", version: PACKAGE_VERSION, bin: { diffci: "cli.js" } })}\n`, "utf8");
      writeFileSync(join(packageDir, "cli.js"), "#!/usr/bin/env node\n", "utf8");
      const pack = process.platform === "win32"
        ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd pack --json"], { cwd: packageDir, encoding: "utf8" })
        : execFileSync("npm", ["pack", "--json"], { cwd: packageDir, encoding: "utf8" });
      const tarball = join(packageDir, (JSON.parse(pack) as Array<{ filename: string }>)[0]!.filename);

      writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify({ name: "consumer", private: true, scripts: { test: "node --test" } }, null, 2)}\n`, "utf8");
      const realNpm = process.platform === "win32"
        ? execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean)!
        : execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
      const npmCli = process.platform === "win32"
        ? join(dirname(realNpm), "node_modules", "npm", "bin", "npm-cli.js")
        : join(execFileSync(realNpm, ["root", "-g"], { encoding: "utf8" }).trim(), "npm", "bin", "npm-cli.js");
      const shimScript = `import { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2).map((arg) => arg.startsWith("@diffci.com/diffci@") ? process.env.DIFFCI_TEST_TARBALL : arg);\nconst result = spawnSync(process.execPath, [process.env.DIFFCI_REAL_NPM_CLI, ...args], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`;
      writeFileSync(join(shimDir, "npm-shim.mjs"), shimScript, "utf8");
      if (process.platform === "win32") {
        writeFileSync(join(shimDir, "npm.cmd"), `@"${process.execPath}" "%~dp0npm-shim.mjs" %*\r\n`, "utf8");
      } else {
        writeFileSync(join(shimDir, "npm"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/npm-shim.mjs" "$@"\n`, "utf8");
        chmodSync(join(shimDir, "npm"), 0o755);
      }
      const env = {
        ...process.env,
        PATH: `${shimDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        DIFFCI_REAL_NPM_CLI: npmCli,
        DIFFCI_TEST_TARBALL: tarball,
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = runCli(["init", "--repo", consumerDir, "--install", "--workflow"], ROOT, env);
        assert.equal(result.status, 0, result.stderr);
      }

      const manifest = JSON.parse(readFileSync(join(consumerDir, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      assert.equal(manifest.scripts.test, "node --test");
      assert.equal(manifest.scripts["diffci:verify"], "diffci verify --changed --json");
      assert.equal(manifest.scripts["diffci:check"], "diffci check");
      assert.equal(manifest.scripts["diffci:observe"], "diffci observe --no-send");
      assert.match(manifest.devDependencies["@diffci.com/diffci"], /^file:/);
      const lock = JSON.parse(readFileSync(join(consumerDir, "package-lock.json"), "utf8")) as { packages?: Record<string, unknown> };
      assert.ok(lock.packages?.["node_modules/@diffci.com/diffci"]);
      assert.match(readFileSync(join(consumerDir, ".github", "workflows", "diffci.yml"), "utf8"), new RegExp(`@diffci\\.com/diffci@${PACKAGE_VERSION.replaceAll(".", "\\.")}`));
      const agentInstructions = readFileSync(join(consumerDir, "AGENTS.md"), "utf8");
      assert.equal(agentInstructions.match(/<!-- diffci:managed:start -->/g)?.length, 1);
      assert.match(agentInstructions, /npm run diffci:verify/);
      assert.doesNotMatch(agentInstructions, /@latest/);
      const config = JSON.parse(readFileSync(join(consumerDir, "diffci.config.json"), "utf8")) as { agentDefaultCommand?: string };
      assert.equal(config.agentDefaultCommand, "npm run diffci:verify");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
