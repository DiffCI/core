// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";

import { mcpServerEntry } from "../packages/diffci-cli/src/client/agent-setup.js";

type McpConfig = { mcpServers: Record<string, { command: string; args: string[] }> };

/** The `node -e` script an agent plugin's MCP configuration starts. */
function launcher(relativePath: string): string {
  const config = JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")) as McpConfig;
  const server = config.mcpServers.diffci!;
  assert.equal(server.command, "node", `${relativePath} starts the server with node`);
  const index = server.args.indexOf("-e");
  assert.ok(index >= 0 && typeof server.args[index + 1] === "string", `${relativePath} passes a script to node -e`);
  return server.args[index + 1]!;
}

// .mcp.json lost the non-Windows branch of its ternary in a version bump and stopped compiling (#166).
for (const path of ["integrations/agent-plugin/mcp.json", "integrations/agent-plugin/.mcp.json"]) {
  test(`${path}: the MCP launcher is valid JavaScript`, () => {
    assert.doesNotThrow(() => new Script(launcher(path), { filename: path }));
  });
}

test("the Codex/Claude (.mcp.json) and Cursor (mcp.json) launchers run the same script", () => {
  assert.equal(launcher("integrations/agent-plugin/.mcp.json"), launcher("integrations/agent-plugin/mcp.json"));
});

test("the Muse launcher is valid JavaScript", () => {
  const path = "integrations/muse-plugin/scripts/launch-diffci-mcp.cjs";
  assert.doesNotThrow(() => new Script(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), { filename: path }));
});

// `diffci init` writes the same launcher into the agents' MCP configuration, and had the same broken ternary.
test("diffci init writes the plugin's MCP launcher, and it is valid JavaScript", () => {
  const plugin = launcher("integrations/agent-plugin/.mcp.json");
  const version = /@diffci\.com\/diffci@([^']+)'/.exec(plugin)?.[1];
  assert.ok(version, "the plugin launcher pins a DiffCI version");
  const script = mcpServerEntry(version).args[1]!;
  assert.doesNotThrow(() => new Script(script, { filename: "diffci init" }));
  assert.equal(script, plugin);
});
