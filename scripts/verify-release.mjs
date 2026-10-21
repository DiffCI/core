// SPDX-License-Identifier: AGPL-3.0-only
// Verifies that npm, the GitHub Release, release tags, the MCP Registry, and the hosted MCP endpoint
// all name the CLI version. A release may verify the first four before its cross-repository site deploy;
// the scheduled consistency workflow verifies every surface after deployment.
// Usage: node scripts/verify-release.mjs [--surfaces=npm,github-release,tags,mcp-registry,hosted-mcp]
import { readFileSync } from "node:fs";
import { findReleaseMismatches, RELEASE_SURFACES, releaseTags } from "./release-surfaces.mjs";

const cli = JSON.parse(readFileSync(new URL("../packages/diffci-cli/package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const version = cli.version;

const surfacesArgument = process.argv.find((argument) => argument.startsWith("--surfaces="));
const surfaces = surfacesArgument ? surfacesArgument.slice("--surfaces=".length).split(",") : RELEASE_SURFACES;
const unknown = surfaces.filter((surface) => !RELEASE_SURFACES.includes(surface));
if (unknown.length > 0) throw new Error(`Unknown release surface: ${unknown.join(", ")}`);

const repository = process.env.GITHUB_REPOSITORY ?? "DiffCI/core";
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const registryUrl = process.env.MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io";
const hostedMcpUrl = process.env.DIFFCI_HOSTED_MCP_URL ?? server.remotes?.find((remote) => remote.type === "streamable-http")?.url;
const hostedMcpServerCardUrl = process.env.DIFFCI_HOSTED_MCP_SERVER_CARD_URL ?? (() => {
  if (!hostedMcpUrl) return undefined;
  const url = new URL(hostedMcpUrl);
  url.pathname = url.pathname.replace(/\/v1$/, "/server-card");
  return url.toString();
})();

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "diffci-release-verifier", ...headers } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function github(path) {
  return getJson(`https://api.github.com/repos/${repository}${path}`, {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
}

async function tagCommit(tag) {
  const ref = await github(`/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) return undefined;
  if (ref.object.type !== "tag") return ref.object.sha;
  const annotated = await github(`/git/tags/${ref.object.sha}`);
  return annotated?.object?.sha;
}

const observed = {};

if (surfaces.includes("npm")) {
  const packument = await getJson(`https://registry.npmjs.org/${cli.name.replace("/", "%2f")}`);
  observed.npm = { latest: packument?.["dist-tags"]?.latest, versions: Object.keys(packument?.versions ?? {}) };
}

if (surfaces.includes("github-release")) {
  const latest = await github("/releases/latest");
  observed.githubLatestRelease = latest && { tag: latest.tag_name, draft: latest.draft, prerelease: latest.prerelease };
}

if (surfaces.includes("tags")) {
  observed.tagCommits = {};
  for (const tag of Object.values(releaseTags(version))) {
    const commit = await tagCommit(tag);
    if (commit) observed.tagCommits[tag] = commit;
  }
}

if (surfaces.includes("mcp-registry")) {
  const payload = await getJson(`${registryUrl}/v0.1/servers?search=${encodeURIComponent(server.name)}&version=latest`);
  const latest = (payload?.servers ?? [])
    .filter((entry) => (entry?.server ?? entry)?.name === server.name)
    .find((entry) => entry?._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest !== false);
  const latestServer = latest?.server ?? latest;
  observed.registryLatest = latestServer && {
    version: latestServer.version,
    packageVersion: latestServer.packages?.find((entry) => entry.identifier === cli.name)?.version,
  };
}

if (surfaces.includes("hosted-mcp")) {
  if (!hostedMcpUrl || !hostedMcpServerCardUrl) throw new Error("MCP server.json must define a streamable HTTP endpoint.");
  const initializeResponse = await fetch(hostedMcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": "diffci-release-verifier",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "diffci-release-verifier",
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "diffci-release-verifier", version: "1" } },
    }),
  });
  if (!initializeResponse.ok) throw new Error(`${hostedMcpUrl} returned HTTP ${initializeResponse.status}`);
  const initialize = await initializeResponse.json();
  // Normal server-card responses are cacheable. Add a request-unique query so a release
  // verification observes the newly deployed Worker rather than a stale CDN response.
  const uncachedServerCardUrl = new URL(hostedMcpServerCardUrl);
  uncachedServerCardUrl.searchParams.set("diffci_release_check", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const serverCard = await getJson(uncachedServerCardUrl.toString(), { "Cache-Control": "no-cache" });
  observed.hostedMcp = {
    initializeVersion: initialize?.result?.serverInfo?.version,
    serverCardVersion: serverCard?.version,
  };
}

const problems = findReleaseMismatches(version, observed, surfaces);
if (problems.length > 0) {
  console.error(`Release surfaces disagree with CLI ${version}:`);
  for (const problem of problems) console.error(`- ${problem}`);
  // Let fetch/Undici clean up normally. Forcing process.exit() after a failed live check can
  // trigger a libuv assertion on Windows while sockets are still being released.
  process.exitCode = 1;
} else {
  console.log(`Release surfaces agree on CLI ${version}: ${surfaces.join(", ")}.`);
}
