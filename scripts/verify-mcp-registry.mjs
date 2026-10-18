import { readFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const cliPackage = JSON.parse(
  readFileSync(new URL("../packages/diffci-cli/package.json", import.meta.url), "utf8"),
);
const expectedPackage = expected.packages?.find((entry) => entry.registryType === "npm");

if (!expectedPackage) throw new Error("server.json must declare an npm package.");
if (expected.version !== cliPackage.version || expectedPackage.version !== cliPackage.version) {
  throw new Error(
    `Registry metadata version mismatch: server=${expected.version}, package=${expectedPackage.version}, CLI=${cliPackage.version}.`,
  );
}
if (cliPackage.mcpName !== expected.name) {
  throw new Error(`MCP ownership name mismatch: expected ${expected.name}, got ${cliPackage.mcpName ?? "none"}.`);
}

const baseUrl = process.env.MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io";
const response = await fetch(`${baseUrl}/v0.1/servers?search=${encodeURIComponent(expected.name)}`, {
  headers: { Accept: "application/json", "User-Agent": "diffci-registry-verifier" },
});
if (!response.ok) throw new Error(`MCP Registry returned HTTP ${response.status}`);

const payload = await response.json();
const entries = Array.isArray(payload) ? payload : Array.isArray(payload.servers) ? payload.servers : [];
const published = entries
  .map((entry) => entry?.server ?? entry)
  .find((server) => server?.name === expected.name && server?.version === expected.version);

if (!published) {
  console.error(`MCP Registry does not yet contain ${expected.name}@${expected.version}.`);
  process.exit(1);
}

const expectedRemote = expected.remotes?.find((remote) => remote.type === "streamable-http")?.url;
const actualRemote = published.remotes?.find((remote) => remote.type === "streamable-http")?.url;
if (actualRemote !== expectedRemote) {
  throw new Error(`MCP Registry remote mismatch: expected ${expectedRemote}, got ${actualRemote ?? "none"}`);
}

const actualPackage = published.packages?.find((entry) => entry.identifier === expectedPackage.identifier);
if (actualPackage?.version !== expectedPackage.version) {
  throw new Error(`MCP Registry package mismatch: expected ${expectedPackage.identifier}@${expectedPackage.version}`);
}

console.log(`MCP Registry contains ${expected.name}@${expected.version} with ${expectedRemote}.`);
