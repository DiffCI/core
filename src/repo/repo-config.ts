/**
 * A repository's own DiffCI configuration (Phase 01 follow-up, 2026-08-26).
 *
 * WHY. `DEFAULT_ALWAYS_RUN_CHECKS` in src/repo/impact.ts forced certain test files to be selected
 * regardless of what the dependency graph said, matching on patterns like `test-api-guardrails`,
 * `verify-*.test.` and `scripts/*.test.mjs`. Those are DiffCI's and DentalPresence's own file names,
 * compiled into the engine and applied to every repository it analysed. On an external repository
 * they matched nothing, so the policy was simultaneously a repo-specific default AND dead weight.
 *
 * The policy itself is worth keeping - some tests really must run regardless of reachability, because
 * they check global properties a dependency graph cannot see. What was wrong is WHERE the list lived.
 * A repository is the only thing that can say which of its own tests those are, so it says so, here:
 *
 *     // package.json
 *     { "diffci": { "alwaysRunTests": ["**\/security.test.*", "scripts/**\/*.test.mjs"] } }
 *
 * or in a `diffci.json` at the repository root, with the same shape. Absent configuration means no
 * always-run policy - not a guessed one.
 *
 * Globs, not regular expressions: globs are already the vocabulary a repository uses to describe its
 * tests (vitest `include`, jest `testMatch`), and they go through the same matcher as everything else
 * so one definition of "does this path match" holds throughout.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DiffCiRepositoryConfig {
  /** Globs for tests that must be selected on every analysed change, regardless of reachability. */
  alwaysRunTests?: string[];
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // Unreadable or malformed configuration is treated as absent rather than as an error. Getting
    // this wrong must not take down analysis of a repository that is otherwise fine; the cost of the
    // mistake is that the repository's own always-run policy silently does not apply, which is the
    // same position every repository was in before this existed.
    return undefined;
  }
}

function parseConfig(raw: unknown): DiffCiRepositoryConfig {
  if (raw === null || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const alwaysRunTests = Array.isArray(record.alwaysRunTests)
    ? record.alwaysRunTests.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : undefined;
  return alwaysRunTests && alwaysRunTests.length > 0 ? { alwaysRunTests } : {};
}

/**
 * Reads the repository's DiffCI configuration. `diffci.json` at the root wins over a `diffci` key in
 * `package.json`; a repository using both has stated a preference by creating the dedicated file.
 */
export function readRepositoryConfig(repoPath: string, packageJson?: Record<string, unknown>): DiffCiRepositoryConfig {
  const dedicated = readJsonFile(join(repoPath, "diffci.json"));
  if (dedicated) {
    const parsed = parseConfig(dedicated);
    if (parsed.alwaysRunTests) return parsed;
  }
  const pkg = packageJson ?? readJsonFile(join(repoPath, "package.json"));
  return parseConfig(pkg?.diffci);
}
