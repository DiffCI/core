// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { findReleaseMismatches, releaseTags, type ObservedRelease } from "../scripts/release-surfaces.mjs";

const COMMIT = "1f9b6b3a9872a0e52fe4e94790e96da330ffb390";

function aligned(version: string): ObservedRelease {
  const tags = releaseTags(version);
  return {
    npm: { latest: version, versions: ["0.3.12", version] },
    githubLatestRelease: { tag: tags.release, draft: false, prerelease: false },
    tagCommits: { [tags.release]: COMMIT, [tags.cli]: COMMIT, [tags.action]: COMMIT },
    registryLatest: { version, packageVersion: version },
    hostedMcp: { initializeVersion: version, serverCardVersion: version },
  };
}

test("aligned release surfaces report no mismatches", () => {
  assert.deepEqual(findReleaseMismatches("0.3.13", aligned("0.3.13")), []);
});

test("the repository's own CLI version names a consistent tag set", async () => {
  const cli = JSON.parse(await readFile(new URL("../packages/diffci-cli/package.json", import.meta.url), "utf8"));
  assert.deepEqual(releaseTags(cli.version), {
    release: `v${cli.version}`,
    cli: `cli-release-v${cli.version}`,
    action: `action-v${cli.version}`,
  });
  assert.deepEqual(findReleaseMismatches(cli.version, aligned(cli.version)), []);
});

test("npm must publish the version and tag it latest", () => {
  const observed = { ...aligned("0.3.13"), npm: { latest: "0.3.12", versions: ["0.3.12"] } };
  assert.deepEqual(findReleaseMismatches("0.3.13", observed), [
    "npm has not published 0.3.13.",
    "npm latest is 0.3.12, expected 0.3.13.",
  ]);
});

test("the latest GitHub Release must be the published version", () => {
  assert.deepEqual(findReleaseMismatches("0.3.13", { ...aligned("0.3.13"), githubLatestRelease: { tag: "v0.3.12" } }), [
    "Latest GitHub Release is v0.3.12, expected v0.3.13.",
  ]);
  assert.deepEqual(
    findReleaseMismatches("0.3.13", { ...aligned("0.3.13"), githubLatestRelease: { tag: "v0.3.13", prerelease: true } }),
    ["GitHub Release v0.3.13 must be published, not a draft or prerelease."],
  );
  assert.deepEqual(findReleaseMismatches("0.3.13", { ...aligned("0.3.13"), githubLatestRelease: null }), [
    "Latest GitHub Release is missing, expected v0.3.13.",
  ]);
});

test("release, CLI and Action tags must all exist on one commit", () => {
  const missingAction = { ...aligned("0.3.13"), tagCommits: { "v0.3.13": COMMIT, "cli-release-v0.3.13": COMMIT } };
  assert.deepEqual(findReleaseMismatches("0.3.13", missingAction), ["Tag action-v0.3.13 is missing."]);

  const split = { ...aligned("0.3.13"), tagCommits: { "v0.3.13": COMMIT, "cli-release-v0.3.13": COMMIT, "action-v0.3.13": "8c70501" } };
  assert.deepEqual(findReleaseMismatches("0.3.13", split), [
    `Tags v0.3.13, cli-release-v0.3.13, action-v0.3.13 must point at one commit; found ${COMMIT}, 8c70501.`,
  ]);
});

test("the MCP Registry latest entry must match the version and its npm package", () => {
  assert.deepEqual(findReleaseMismatches("0.3.13", { ...aligned("0.3.13"), registryLatest: { version: "0.3.12", packageVersion: "0.3.12" } }), [
    "MCP Registry latest is 0.3.12, expected 0.3.13.",
  ]);
  assert.deepEqual(findReleaseMismatches("0.3.13", { ...aligned("0.3.13"), registryLatest: { version: "0.3.13", packageVersion: "0.3.12" } }), [
    "MCP Registry 0.3.13 points at npm 0.3.12, expected 0.3.13.",
  ]);
});

test("the hosted MCP initialize response and server card must match the release", () => {
  assert.deepEqual(findReleaseMismatches("0.3.13", {
    ...aligned("0.3.13"), hostedMcp: { initializeVersion: "0.3.12", serverCardVersion: "0.3.13" },
  }), ["Hosted MCP initialize reports 0.3.12, expected 0.3.13."]);
  assert.deepEqual(findReleaseMismatches("0.3.13", {
    ...aligned("0.3.13"), hostedMcp: { initializeVersion: "0.3.13", serverCardVersion: "0.3.12" },
  }), ["Hosted MCP server card reports 0.3.12, expected 0.3.13."]);
});

test("surfaces can be checked selectively before the registry is published", () => {
  const beforeRegistry = { ...aligned("0.3.13"), registryLatest: { version: "0.3.12", packageVersion: "0.3.12" } };
  assert.deepEqual(findReleaseMismatches("0.3.13", beforeRegistry, ["npm", "github-release", "tags"]), []);
});
