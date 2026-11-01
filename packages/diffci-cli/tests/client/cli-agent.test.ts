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
    assert.match(result.stdout, /diffci init \[--repo <path>\] \[--workflow\] \[--verification-workflow\] \[--install\] \[--hook\] \[--force\]/);
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
