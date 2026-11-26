// SPDX-License-Identifier: MIT

/** Every public surface that must name the same CLI release. */
export const RELEASE_SURFACES = ["npm", "github-release", "tags", "mcp-registry", "hosted-mcp"];

export function releaseTags(version) {
  return { release: `v${version}`, cli: `cli-release-v${version}`, action: `action-v${version}` };
}

/**
 * The floating major tag (`v0`) for users who choose `uses: DiffCI/core@v0` and want every release without a
 * pin bump. `npm run release:float` moves it only once npm serves the release tarball, so `@v0` never points at
 * an Action whose CLI version can't be installed yet (a staged npm publish 404s until approved).
 */
export function floatingTag(version) {
  return `v${String(version).split(".")[0]}`;
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
    const floating = floatingTag(version);
    const release = commits[tags.release];
    if (release && commits[floating] !== release) {
      problems.push(`Floating tag ${floating} is at ${commits[floating]?.slice(0, 7) ?? "nothing"}, not ${tags.release} (${release.slice(0, 7)}): run npm run release:float once npm serves the tarball.`);
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

  if (surfaces.includes("hosted-mcp")) {
    const hosted = observed.hostedMcp;
    if (hosted?.initializeVersion !== version) {
      problems.push(`Hosted MCP initialize reports ${hosted?.initializeVersion ?? "missing"}, expected ${version}.`);
    }
    if (hosted?.serverCardVersion !== version) {
      problems.push(`Hosted MCP server card reports ${hosted?.serverCardVersion ?? "missing"}, expected ${version}.`);
    }
  }

  return problems;
}
