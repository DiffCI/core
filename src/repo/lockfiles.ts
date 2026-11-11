// SPDX-License-Identifier: MIT
/**
 * The one lockfile-name pattern behind every lockfile signal (2026-10-30, issue #47).
 *
 * Four copies of this regex had drifted apart: the planner's three (`check-narrowing.ts`,
 * `script-reads.ts`, `type-program.ts`) knew npm's shrinkwrap and Bun's text lockfile, while the
 * git-diff signal in `git-diff.ts` did not, so a change to `bun.lock` or `npm-shrinkwrap.json`
 * alone still forced the full suite. Sharing this constant keeps the signals in agreement.
 */
export const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

/**
 * The same lockfiles as names, for code that needs the files rather than a regex (issue #97). Every name
 * here matches `LOCKFILE`, and `tests/repo/lockfiles.test.ts` checks that the two stay in agreement.
 */
export const LOCKFILE_NAMES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];
