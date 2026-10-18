import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

const cli = readJson("packages/diffci-cli/package.json");
const version = cli.version;
assert(typeof version === "string" && version.length > 0, "CLI package must declare a version.");

const cliLock = readJson("packages/diffci-cli/package-lock.json");
assert(cliLock.version === version && cliLock.packages?.[""]?.version === version, "CLI package lockfile must match the package version.");

const server = readJson("server.json");
assert(server.version === version, "MCP Registry version must match the CLI package version.");
assert(server.packages?.some((entry) => entry.identifier === "@diffci.com/diffci" && entry.version === version), "MCP Registry package entry must match the CLI package version.");

const portable = readJson("integrations/agent-plugin/plugin.json");
const claude = readJson("integrations/agent-plugin/.claude-plugin/plugin.json");
const cursor = readJson("integrations/agent-plugin/.cursor-plugin/plugin.json");
const codex = readJson("integrations/agent-plugin/.codex-plugin/plugin.json");
for (const [name, manifest] of Object.entries({ portable, claude, cursor, codex })) {
  assert(manifest.version === version, `${name} plugin version must match the CLI package version.`);
}

const agentMcp = readText("integrations/agent-plugin/mcp.json");
const hiddenAgentMcp = readText("integrations/agent-plugin/.mcp.json");
for (const [name, launcher] of Object.entries({ agentMcp, hiddenAgentMcp })) {
  assert(launcher.includes(`@diffci.com/diffci@${version}`), `${name} must pin the CLI package version.`);
}

const action = readText("action.yml");
assert(action.includes(`default: "${version}"`), "GitHub Action must default to the CLI package version.");
assert(action.includes("DIFFCI_CLI_VERSION: ${{ inputs.cli-version }}"), "GitHub Action must pass its version through an environment variable.");
assert(action.includes('"@diffci.com/diffci@$DIFFCI_CLI_VERSION"'), "GitHub Action must use the validated CLI version.");

const muse = readJson("integrations/muse-plugin/.muse-plugin/plugin.json");
assert(muse.schemaVersion === 1, "Muse manifest must use schemaVersion 1.");
assert(muse.name === "diffci" && muse.version === version, "Muse manifest must track the CLI package version.");
assert(muse.compat?.manifestDir === ".muse-plugin", "Muse manifest must name its own manifest directory.");
assert(muse.capabilities?.mcpServers?.length === 1, "Muse manifest must declare one local MCP server.");
assert(muse.capabilities.mcpServers[0]?.id === "diffci", "Muse MCP server id must be diffci.");
assert(JSON.stringify(muse.capabilities.mcpServers[0]?.command) === JSON.stringify(["node", "scripts/launch-diffci-mcp.cjs"]), "Muse MCP server must use the packaged launcher.");
assert(readText("integrations/muse-plugin/scripts/launch-diffci-mcp.cjs").includes(`@diffci.com/diffci@${version}`), "Muse launcher must pin the CLI package version.");
assert(readText("integrations/muse-plugin/skills/diffci-verify/SKILL.md") === readText("integrations/agent-plugin/skills/diffci-verify/SKILL.md"), "Muse and portable plugin skills must stay identical.");

const marketplace = readJson("marketplace.json");
const museCatalogEntry = marketplace.plugins?.find((entry) => entry.name === "diffci");
assert(marketplace.schemaVersion === 1 && marketplace.source === "local", "Muse marketplace must use the native catalog format.");
assert(museCatalogEntry?.version === version, "Muse marketplace version must match the CLI package version.");
assert(museCatalogEntry?.install?.transport === "local-path" && museCatalogEntry.install.source === "integrations/muse-plugin", "Muse marketplace must install the native package.");
assert(/^sha256:[a-f0-9]{64}$/.test(museCatalogEntry?.integrity?.digest ?? ""), "Muse marketplace must carry a package SHA-256 digest.");

const installationGuide = readText("docs/agent-installation.md");
assert(installationGuide.includes(`@diffci.com/diffci@${version}`), "Agent installation guide must pin the CLI package version.");

for (const relativePath of [
  "docs/agent-installation.md",
  "integrations/muse-plugin/.muse-plugin/plugin.json",
  "integrations/muse-plugin/scripts/launch-diffci-mcp.cjs",
  "integrations/muse-plugin/skills/diffci-verify/SKILL.md",
]) {
  assert(existsSync(resolve(root, relativePath)), `Missing cross-agent distribution file: ${relativePath}`);
}

console.log(`Agent packaging passed: DiffCI ${version} metadata and launchers are aligned.`);
