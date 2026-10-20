// SPDX-License-Identifier: AGPL-3.0-only

export type ReleaseSurface = "npm" | "github-release" | "tags" | "mcp-registry";

export interface ObservedRelease {
  npm?: { latest?: string; versions?: string[] };
  githubLatestRelease?: { tag: string; draft?: boolean; prerelease?: boolean } | null;
  /** Tag name to the commit it resolves to; absent tags are omitted. */
  tagCommits?: Record<string, string>;
  registryLatest?: { version: string; packageVersion?: string } | null;
}

export const RELEASE_SURFACES: ReleaseSurface[];

export function releaseTags(version: string): { release: string; cli: string; action: string };

export function findReleaseMismatches(
  version: string,
  observed: ObservedRelease,
  surfaces?: readonly ReleaseSurface[],
): string[];
