// SPDX-License-Identifier: AGPL-3.0-only

/** Every public surface that must name the same CLI release. */
export const RELEASE_SURFACES = ["npm", "github-release", "tags", "mcp-registry"];

export function releaseTags(version) {
  return { release: `v${version}`, cli: `cli-release-v${version}`, action: `action-v${version}` };
}

/**
 * Compares observed public release state with the CLI package version.
 * Returns one human-readable problem per mismatch; an empty list means every surface agrees.
 */
export function findReleaseMismatches(version, observed, surfaces = RELEASE_SURFACES) {
  const problems = [];
  const tags = releaseTags(version);

  if (surfaces.includes("npm")) {
    const latest = observed.npm?.latest;
    if (!observed.npm?.versions?.includes(version)) problems.push(`npm has not published ${version}.`);
    if (latest !== version) problems.push(`npm latest is ${latest ?? "missing"}, expected ${version}.`);
  }

  if (surfaces.includes("github-release")) {
    const latest = observed.githubLatestRelease;
    if (latest?.tag !== tags.release) {
      problems.push(`Latest GitHub Release is ${latest?.tag ?? "missing"}, expected ${tags.release}.`);
    } else if (latest.draft || latest.prerelease) {
      problems.push(`GitHub Release ${tags.release} must be published, not a draft or prerelease.`);
    }
  }

  if (surfaces.includes("tags")) {
    const commits = observed.tagCommits ?? {};
    for (const tag of Object.values(tags)) {
      if (!commits[tag]) problems.push(`Tag ${tag} is missing.`);
    }
    const distinct = new Set(Object.values(tags).map((tag) => commits[tag]).filter(Boolean));
    if (distinct.size > 1) {
      problems.push(`Tags ${Object.values(tags).join(", ")} must point at one commit; found ${[...distinct].join(", ")}.`);
    }
  }

  if (surfaces.includes("mcp-registry")) {
    const registry = observed.registryLatest;
    if (registry?.version !== version) {
      problems.push(`MCP Registry latest is ${registry?.version ?? "missing"}, expected ${version}.`);
    } else if (registry.packageVersion !== version) {
      problems.push(`MCP Registry ${version} points at npm ${registry.packageVersion ?? "nothing"}, expected ${version}.`);
    }
  }

  return problems;
}
