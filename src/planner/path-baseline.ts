/**
 * The PATH baseline: what a simple, honest path-rule CI would select for a change.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. This is the comparator. Every "DiffCI could have avoided X"
 * figure is DiffCI measured against this, so if the baseline is weak, the saving is overstated - and
 * a savings figure is the thing an invoice would eventually be built from.
 *
 * WHAT WAS WRONG (Phase 01 follow-up, 2026-08-26). The scoping rules were literally
 * `src/** -> tests under src/`, `scripts/** -> tests under scripts/`, `ops/** -> tests under ops/`.
 * That is DentalPresence's colocated layout, written down. Measured over five commits each on six
 * external repositories, before the rewrite:
 *
 *   nestjs/nest          0 of 5 commits scoped   (every one "no matching path rule -> run all tests")
 *   facebook/docusaurus  0 of 5
 *   typeorm/typeorm      1 of 5
 *   immerjs/immer        2 of 5   (both of them merely docs-only skips)
 *
 * On a monorepo nothing matched at all, and even on a repository WITH a top-level `src/`, the rule
 * selected tests whose path starts with `src/` - which is empty for any project keeping tests in
 * `test/`. So the comparator was in practice "run the entire suite", including for this repository
 * itself. DiffCI was being compared against running everything and called the difference a saving.
 *
 * WHAT REPLACES IT. Two scoping patterns, both derived from the repository's own tree rather than
 * from any particular directory name:
 *
 *   COLOCATED - select the tests under the deepest ancestor directory of the changed file that
 *   contains any test. For `packages/core/injector/injector.ts` in a monorepo whose tests live at
 *   `packages/core/test/`, that resolves to `packages/core` - which is what a path-rule CI would
 *   really do, and what the old rules could never express.
 *
 *   MIRRORED - when a repository keeps tests in their own root that mirrors a source root
 *   (`src/repo/impact.ts` <-> `tests/repo/impact.test.ts`), select the tests under the mirrored
 *   directory. This is the layout the colocated rule cannot see, and it is this repository's own.
 *
 * When neither localises the change, the baseline runs everything and says so - the same honest
 * answer as before, now reached because the change genuinely could not be scoped rather than because
 * the rules described someone else's repository.
 */
import type { ChangedFile } from "../git/types.js";
import type { RepositoryProfile } from "../repo/types.js";
import { repositoryLayout, UNKNOWN_REPOSITORY_LAYOUT } from "../repo/layout.js";

export interface PathBaselineResult {
  strategy: "PATH_BASELINE";
  selectedTests: string[];
  fallbackRequired: boolean;
  fallbackReasons: string[];
  matchedRules: string[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/** Every directory that contains at least one test at any depth below it. */
function directoriesContainingTests(allTestPaths: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const test of allTestPaths) {
    let dir = directoryOf(toPosix(test));
    for (;;) {
      dirs.add(dir);
      if (dir === "") break;
      dir = directoryOf(dir);
    }
  }
  return dirs;
}

function isUnder(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/** The deepest ancestor directory of `changedPath` that contains any test, or undefined when only the
 * repository root does - which is not a scoping, it is "run everything". */
function nearestTestScope(changedPath: string, testDirs: ReadonlySet<string>): string | undefined {
  let dir = directoryOf(changedPath);
  while (dir !== "") {
    if (testDirs.has(dir)) return dir;
    dir = directoryOf(dir);
  }
  return undefined;
}

/** For a repository whose tests live in their own root mirroring a source root, the directory under
 * that test root corresponding to the changed file. */
function mirroredTestScopes(changedPath: string, profile: RepositoryProfile | undefined, testDirs: ReadonlySet<string>): string[] {
  if (!profile) return [];
  const sourceRoots = profile.sourceRoots.filter((r) => r.kind !== "tests").map((r) => toPosix(r.path));
  const testRoots = profile.sourceRoots.filter((r) => r.kind === "tests").map((r) => toPosix(r.path));
  if (testRoots.length === 0) return [];

  const containing = sourceRoots.find((root) => isUnder(changedPath, root));
  if (containing === undefined) return [];
  const relativeDir = directoryOf(changedPath.slice(containing.length + 1));

  const scopes: string[] = [];
  for (const testRoot of testRoots) {
    // Walk the mirrored directory upward until one that actually holds tests is found, so a change in
    // `src/a/b/c.ts` still scopes to `tests/a` when the mirror is only that deep.
    let candidate = relativeDir === "" ? testRoot : `${testRoot}/${relativeDir}`;
    for (;;) {
      if (testDirs.has(candidate)) { scopes.push(candidate); break; }
      if (!isUnder(candidate, testRoot) || candidate === testRoot) break;
      candidate = directoryOf(candidate);
    }
  }
  return scopes;
}

const INFRASTRUCTURE_DIRECTORIES = new Set([
  "ops", "terraform", "cloudformation", "pulumi", "cdktf", "deploy", "deployments", "kubernetes", "k8s", "helm", "docker",
]);
const DATABASE_DIRECTORIES = new Set(["database", "migrations", "prisma", "drizzle", "supabase", "schema"]);

function firstSegment(path: string): string {
  const index = path.indexOf("/");
  return index === -1 ? path : path.slice(0, index);
}

export function runPathBaseline(
  allTestPaths: string[],
  changedFiles: ChangedFile[],
  profile?: RepositoryProfile,
): PathBaselineResult {
  const changedPaths = changedFiles.map((f) => toPosix(f.path));
  const matchedRules: string[] = [];

  const layout = profile ? repositoryLayout(profile) : UNKNOWN_REPOSITORY_LAYOUT;
  const docsOnly = changedPaths.every((p) => layout.isDocumentationPath(p) || p.startsWith("README"));
  if (docsOnly) {
    matchedRules.push("docs-only -> skip tests");
    return { strategy: "PATH_BASELINE", selectedTests: [], fallbackRequired: false, fallbackReasons: [], matchedRules };
  }

  const runEverything = (rule: string, reason: string): PathBaselineResult => {
    matchedRules.push(rule);
    return { strategy: "PATH_BASELINE", selectedTests: allTestPaths, fallbackRequired: true, fallbackReasons: [reason], matchedRules };
  };

  if (changedPaths.some((p) => p === "package.json" || p === "package-lock.json" || /^(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(p))) {
    return runEverything("config/dependency -> full fallback", "config/dependency change triggers full fallback");
  }
  if (changedPaths.some((p) => p.startsWith(".github/workflows/"))) {
    return runEverything("workflow change -> full fallback", "workflow change triggers full fallback");
  }
  if (changedPaths.some((p) => DATABASE_DIRECTORIES.has(firstSegment(p)))) {
    return runEverything("database -> full fallback", "database change triggers full fallback");
  }
  if (
    changedPaths.some(
      (p) => INFRASTRUCTURE_DIRECTORIES.has(firstSegment(p)) || p.startsWith("docker") || p.includes("Dockerfile"),
    )
  ) {
    return runEverything("infrastructure -> full fallback", "infrastructure change triggers full fallback");
  }

  const testDirs = directoriesContainingTests(allTestPaths);
  const scopes = new Set<string>();
  let unscopable = false;

  for (const changedPath of changedPaths) {
    const mirrored = mirroredTestScopes(changedPath, profile, testDirs);
    if (mirrored.length > 0) {
      for (const scope of mirrored) scopes.add(scope);
      continue;
    }
    const nearest = nearestTestScope(changedPath, testDirs);
    if (nearest !== undefined) {
      scopes.add(nearest);
      continue;
    }
    // A change no directory scoping can localise makes the whole baseline unscoped - a path-rule CI
    // that cannot place ONE changed file has to run everything, regardless of how well it placed the
    // rest. Recording it per-file and then ignoring it would flatter the baseline.
    unscopable = true;
  }

  if (unscopable || scopes.size === 0) {
    return runEverything("no directory scoping applies -> run all tests", "unscopable changed paths");
  }

  const sortedScopes = Array.from(scopes).sort();
  matchedRules.push(`directory scoping -> tests under ${sortedScopes.join(", ")}`);
  // Sorted, so a selection is comparable across runs rather than inheriting the caller's input order.
  const selected = allTestPaths.filter((test) => sortedScopes.some((scope) => isUnder(toPosix(test), scope))).sort();

  if (selected.length === 0) {
    return runEverything("directory scoping selected nothing -> run all tests", "scoping produced an empty selection");
  }

  return { strategy: "PATH_BASELINE", selectedTests: selected, fallbackRequired: false, fallbackReasons: [], matchedRules };
}
