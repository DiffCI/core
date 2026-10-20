// SPDX-License-Identifier: AGPL-3.0-only
// Verifies that npm, the GitHub Release, the release tags and the MCP Registry all name the CLI version.
// Usage: node scripts/verify-release.mjs [--surfaces=npm,github-release,tags,mcp-registry]
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

const problems = findReleaseMismatches(version, observed, surfaces);
if (problems.length > 0) {
  console.error(`Release surfaces disagree with CLI ${version}:`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`Release surfaces agree on CLI ${version}: ${surfaces.join(", ")}.`);
