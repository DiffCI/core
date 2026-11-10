import { extname, posix } from "node:path";
import { isGoDiscoveryIgnoredPath } from "./adapters/go.js";
import { inVuePackage } from "./vue-scope.js";
import type { ChangedFile, GitDelta } from "../git/types.js";
import type { DependencyGraph, DependencyGraphNode, DependencyGraphResult, EntryPoint, RepositoryProfile, UnresolvedDependency } from "./types.js";
import type { ChangedImpact, EntryPointImpact, ImpactEvidence, ImpactEvidencePath, ImpactReason, ImpactResult, ImpactRiskSignal, TestImpact } from "./impact-types.js";
import { refineConfidenceForDelta, relevantScopedAdapterBlockers } from "./graph.js";
import { repositoryLayout, UNKNOWN_REPOSITORY_LAYOUT, type RepositoryLayout } from "./layout.js";
import { DEFAULT_TEST_FILE_MATCHER, matchesGlob as matchesTestGlob, testDiscoveryErrors, testFileMatcherForProfile } from "./test-discovery.js";
import { resolveTestFixtureOwners } from "./test-fixture-ownership.js";
import { compilerConfigNames, contentNamesPath, directoryWalkers, DIRECTING_EXTENSIONS, infrastructureRole, isAgentConfigurationPath, listsDirectories, loadsWithoutNaming, isImplicitlyLoadedFile, isWorkerConfig, referencePattern, referenceTokens, resolveFileReferences, suiteMayRunWorkers, testScriptClosure } from "./file-references.js";
import { workflowFeedsTests } from "./workflow-test-steps.js";
import { modelTestScriptUniverse, type ScriptUniverse } from "./script-universe.js";
import { compiledProjects, type CompiledProject } from "./compiled-projects.js";
import { isPlaywrightSpec, nextAppRoute, routeMatches, visitedRoutes } from "./route-visits.js";
import { exportLevelReach } from "./export-reach.js";

const SOURCE_EXTENSIONS = new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".mts",".cts",".vue",".go",".java",".kt"]);
const ASSET_EXTENSIONS = new Set([".css",".scss",".sass",".less",".json",".jsonc",".svg",".png",".jpg",".jpeg",".gif",".webp",".ico",".bmp",".woff",".woff2",".ttf",".otf",".eot",".wasm",".md",".txt"]);
const NEXT_ENTRY_NAMES = new Set(["page","layout","route","api","loading","error","template","not-found","middleware","generatemetadata","generatestaticparams"]);

// Lockfiles are reported by the lockfile rule; resolving their readers would only repeat it.
function isLockfile(filePath: string): boolean { return /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(filePath); }
function isSourceFilePath(filePath: string): boolean { return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase()); }
function isAssetFilePath(filePath: string): boolean { return ASSET_EXTENSIONS.has(extname(filePath).toLowerCase()); }
function isGoReaderFile(filePath: string): boolean { return filePath.endsWith(".go"); }
/**
 * Reads a go reader's references without its import clauses: an import names the package, not any
 * directory inside it, and counting `example.com/project/p` as a reference to a changed `p/...`
 * path would disqualify every sibling package's package-owned testdata route (2026-11-09, review of
 * #85). String literals and call arguments — where a testdata read actually appears — are kept.
 */
function goReaderReferences(content: string): string {
  return content
    .replace(/^[ \t]*import[ \t]+[^(){}[\]\n]*\n/gm, "")
    .replace(/^[ \t]*import[ \t]*\([^)]*\)[ \t]*(?:\/\/[^\n]*)?\n/gm, "");
}
/** Vitest's default `typecheck.include`: tests whose outcome is the type checker's. */
const TYPE_TEST_FILE = /\.(?:test|spec)-d\.[cm]?[jt]sx?$/;
/** tstyche type tests, which type-check whatever they import. */
const TYPE_CHECK_TEST_FILE = /\.tst\.[cm]?[jt]sx?$/;
// "Is this a test?" is answered by the profile's test patterns (src/repo/test-discovery.ts) - one shared
// definition with analyzer discovery and graph node flags. Module-level helpers receive it explicitly.
type IsTestFile = (filePath: string) => boolean;
// Phase 01 follow-up (2026-08-26): "is this auxiliary code?" and "is this documentation?" are answered
// from the repository's own discovered layout (src/repo/layout.ts), not from DiffCI's directory names.
// These previously read `startsWith("scripts/") || startsWith("ops/")` and `startsWith("docs/")`, which
// classified nothing in a repository organised any other way and could never fire in one without those
// exact directories.
function isScriptFile(filePath: string, layout: RepositoryLayout): boolean { return layout.isScriptPath(filePath); }
function isDocumentationFile(filePath: string, layout: RepositoryLayout): boolean { return layout.isDocumentationPath(filePath); }
function isConfigFile(filePath: string): boolean {
  const CONFIG_FILE_NAMES = new Set(["package.json","package-lock.json","yarn.lock","pnpm-lock.yaml","bun.lockb","bun.lock","tsconfig.json","tsconfig.base.json","tsconfig.build.json","jsconfig.json"]);
  const base = posix.basename(filePath);
  if (["go.mod", "go.sum", "go.work", "go.work.sum"].includes(base)) return true;
  if (/^(?:vite|vue|nuxt)\.config\./.test(base)) return true;
  if (CONFIG_FILE_NAMES.has(base)) return true;
  if (base.startsWith("next.config")) return true;
  if (base.startsWith("tailwind.config")) return true;
  if (base.startsWith("postcss.config")) return true;
  if (base.startsWith("eslint.config")) return true;
  if (base.startsWith(".eslintrc")) return true;
  if (base.startsWith("vitest.config")) return true;
  if (base.startsWith("jest.config")) return true;
  if (base.startsWith("prettier.config")) return true;
  if (base.startsWith(".prettierrc")) return true;
  if (/^\.github\/(?:workflows|actions)\//.test(filePath)) return true;
  if (filePath.includes("/Dockerfile")) return true;
  if (filePath.startsWith("docker")) return true;
  return false;
}
// Only conventionally-loaded deployment definitions are global (src/repo/file-references.ts,
// infrastructureRole). Code, documentation and data under ops/ and its siblings are classified like
// the same files anywhere else (2026-10-21).
function isInfrastructureFile(filePath: string): boolean { return infrastructureRole(filePath) === "definition"; }
function isDatabaseFile(filePath: string): boolean { const DATABASE_DIRS = new Set(["database","migrations","prisma","drizzle","supabase","schema"]); const first = filePath.split("/")[0]; return first ? DATABASE_DIRS.has(first) : false; }
/**
 * Next.js file-name conventions, applied ONLY to repositories that are Next.js applications.
 *
 * Phase 01 follow-up (2026-08-26): this took no layout argument and was called unconditionally, so
 * every repository got Next.js semantics for any file named `page`, `layout`, `route`, `error`,
 * `template` or `middleware`. Measured across the Phase 01 cohort it mislabelled files in five of
 * nine repositories - `unjs/h3` has seven, where `route` and `error` are HTTP concepts with nothing
 * to do with Next. The effect was conservative (entry points widen selection) but the plan asserted
 * something false about the repository, and a wrong reason is not made acceptable by a safe outcome.
 */
function classifyNextEntryPoint(filePath: string, layout: RepositoryLayout): EntryPoint["kind"] | undefined { if (!layout.isNextApp) return undefined; if (!isSourceFilePath(filePath)) return undefined; const base = posix.basename(filePath, extname(filePath)); const lower = base.toLowerCase(); if (lower === "page") return "next-page"; if (lower === "layout") return "next-layout"; if (lower === "route") return "next-route"; if (lower === "api" && filePath.includes("/api/")) return "next-api"; if (lower === "loading") return "next-loading"; if (lower === "error") return "next-error"; if (lower === "template") return "next-template"; if (lower === "not-found") return "next-error"; if (lower === "middleware") return "next-api"; return undefined; }
function allChangePaths(file: ChangedFile): string[] { return file.oldPath ? [file.path, file.oldPath] : [file.path]; }
/** The module an extensionless import of `path` names: `a/x.ts` -> `a/x`, `a/x/index.ts` -> `a/x`. */
function moduleKey(path: string): string { const stem = path.replace(/\.[^./]+$/, ""); return posix.basename(stem) === "index" ? posix.dirname(stem) : stem; }
function nodeByPath(graph: DependencyGraph, path: string): DependencyGraphNode | undefined { return graph.nodes.find((n) => n.path === path); }
function hasNode(graph: DependencyGraph, path: string): boolean { return nodeByPath(graph, path) !== undefined; }
function isEntryPoint(profile: RepositoryProfile, path: string): EntryPoint | undefined { return profile.entryPoints.find((e) => e.path === path); }
function isPotentialNextEntryPoint(path: string, layout: RepositoryLayout): boolean { if (!layout.isNextApp) return false; if (!isSourceFilePath(path)) return false; const base = posix.basename(path, extname(path)).toLowerCase(); return NEXT_ENTRY_NAMES.has(base); }
function isNextLayoutProfile(layout: RepositoryLayout): boolean { return layout.isNextApp; }
function isNextLayoutEntry(layout: RepositoryLayout, filePath: string): boolean { if (!isNextLayoutProfile(layout)) return false; const base = posix.basename(filePath, extname(filePath)).toLowerCase(); return base === "layout"; }
function parentRouteDirectory(filePath: string): string | undefined { const idx = filePath.lastIndexOf("/"); if (idx <= 0) return undefined; return filePath.slice(0, idx); }
function isDescendantOf(parentDir: string, candidateFile: string): boolean { const parent = parentDir.endsWith("/") ? parentDir : `${parentDir}/`; return candidateFile.startsWith(parent); }
function collectDescendantEntryPoints(profile: RepositoryProfile, layout: RepositoryLayout, layoutPath: string): EntryPoint[] { const layoutDir = parentRouteDirectory(layoutPath); if (!layoutDir) return []; return profile.entryPoints.filter((ep) => { if (ep.path === layoutPath) return false; if (!isPotentialNextEntryPoint(ep.path, layout)) return false; return isDescendantOf(layoutDir, ep.path); }); }

function shortestPathBFS(graph: DependencyGraph, start: string, target: string, direction: "dependents" | "dependencies", maxDepth = 8): string[] | undefined {
  if (start === target) return [start];
  const adjacency = direction === "dependents" ? (p: string) => graph.dependentsOf(p) : (p: string) => graph.dependenciesOf(p);
  const visited = new Map<string, string | null>();
  const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }];
  visited.set(start, null);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const next of adjacency(current.path)) {
      if (visited.has(next)) continue;
      visited.set(next, current.path);
      if (next === target) {
        const result: string[] = [target];
        let back: string | null | undefined = current.path;
        while (back) { result.unshift(back); back = visited.get(back); }
        return result;
      }
      queue.push({ path: next, depth: current.depth + 1 });
    }
  }
  return undefined;
}
function shortestDependentPathToTest(graph: DependencyGraph, changedFilePath: string, testPath: string): ImpactEvidencePath | undefined {
  const path = shortestPathBFS(graph, changedFilePath, testPath, "dependents", 12);
  if (!path) return undefined;
  return { changedFile: changedFilePath, path, pathKind: "dependents" };
}
function collectScriptsAmong(candidates: Iterable<string>, isTestFile: IsTestFile, layout: RepositoryLayout): string[] { const result: string[] = []; for (const path of candidates) { if (isScriptFile(path, layout) && !isTestFile(path)) result.push(path); } return result.sort(); }
function makeEvidence(reason: ImpactReason, changedFile: string, message: string, affectedFile?: string, path?: ImpactEvidencePath): ImpactEvidence { return { reason, changedFile, affectedFile, message, path }; }

function classifyChangedFile(file: ChangedFile, isTestFile: IsTestFile, layout: RepositoryLayout, repositoryFiles?: ReadonlySet<string>, referenceResolved: ReadonlySet<string> = new Set(), pythonSources: ReadonlySet<string> = new Set()): ChangedImpact["category"] {
  const path = file.path;
  const oldPath = file.oldPath;
  // Only coding agents read these (file-references.ts, isAgentConfigurationPath).
  if (isAgentConfigurationPath(path) && (!oldPath || isAgentConfigurationPath(oldPath))) return "docs";
  // Content inspection in analyzeGitDelta showed these cannot change how tests run; who reads them is
  // resolved by reference (2026-10-21).
  if (referenceResolved.has(path)) return "unknown";
  if (isConfigFile(path) || (oldPath && isConfigFile(oldPath))) return "config";
  if (isInfrastructureFile(path) || (oldPath && isInfrastructureFile(oldPath))) return "infrastructure";
  if (infrastructureRole(path) === "data") return "unknown";
  if (isDatabaseFile(path) || (oldPath && isDatabaseFile(oldPath))) return "database";
  // A .py file is code only where the Python adapter modelled it (2026-11-06); elsewhere, such as a
  // script in a JavaScript repository, it stays an unknown file whose readers are resolved by reference.
  if (isSourceFilePath(path) || pythonSources.has(path)) {
    if (isTestFile(path)) return "test";
    if (isScriptFile(path, layout)) return "script";
    if (classifyNextEntryPoint(path, layout)) return "entry-point";
    return "source";
  }
  if (isAssetFilePath(path)) return "asset";
  if (isDocumentationFile(path, layout)) return "docs";
  if (isTranslatedDocumentationCompanion(path, repositoryFiles)) return "docs";
  // Recorded test inputs under <scope>/tests/<snapshots|fixtures>/ are owned by the tests beside them
  // (src/repo/test-fixture-ownership.ts). Only claimed when an owner can actually be resolved at HEAD.
  if (resolveTestFixtureOwners(path, isTestFile, repositoryFiles)) return "test-fixture";
  return "unknown";
}

/**
 * Executable directly-changed tests (2026-08-24): the set of added / modified / renamed-destination /
 * copied-destination test files in a delta that MUST be present in the final selected-test set. This is
 * the "changed-test self-selection" invariant's input. Deleted tests are excluded (their paths no longer
 * exist at HEAD and must never be executed; a deleted test is instead handled conservatively elsewhere).
 * Only `file.path` is considered here: for a rename/copy that is the destination (the source identity is
 * `file.oldPath` and is intentionally not a test to run).
 */
export function directlyChangedExecutableTests(delta: GitDelta, isTestFile: IsTestFile): string[] {
  const result = new Set<string>();
  for (const file of delta.files) {
    if (file.changeType === "deleted") continue;
    const path = file.path;
    if (isSourceFilePath(path) && isTestFile(path)) result.add(path);
  }
  return Array.from(result).sort();
}

/**
 * Translated-documentation companion records (2026-08-23, docs/research/2026-08-23-deepseek-harness-
 * benchmark.md): the deepseek-harness benchmark showed 26/28 fallbacks carried "Unknown changed file"
 * and 777 of those files were `<doc>.i18n.yaml` - per-document translation-pairing metadata (the git
 * blob hashes of `<doc>.md` / `<doc>.zh.md`) consumed only by a pre-push gate and a merge driver,
 * never by runtime code or tests. Classifying them as docs is a RELATIONSHIP rule, not a YAML rule:
 *   1. the file name is `<base>.<tag>.yaml|yml` where <tag> denotes translation METADATA
 *      (`i18n`, `l10n`, `translation`, `translations`) - NOT a locale code, because `<base>.en.yaml`
 *      is just as plausibly runtime i18n content loaded by a site generator;
 *   2. a Markdown document `<base>.md` / `<base>.mdx` exists beside it at HEAD - the companion must
 *      actually accompany a document; and
 *   3. the caller supplied the HEAD file list at all. Without it the relationship cannot be verified
 *      and the file stays "unknown" (full validation) - existing callers that pass nothing see
 *      byte-identical behavior.
 * Ordinary YAML (CI config, locale bundles under `locales/`, anything without the documented
 * companion) never reaches this check as docs. Config/infra/database classification runs first, so
 * e.g. `.github/README.i18n.yaml` still counts as config.
 */
const TRANSLATION_METADATA_TAGS = new Set(["i18n", "l10n", "translation", "translations"]);
export function isTranslatedDocumentationCompanion(filePath: string, repositoryFiles: ReadonlySet<string> | undefined): boolean {
  if (!repositoryFiles) return false;
  const base = posix.basename(filePath);
  const match = /^(.+)\.([A-Za-z0-9_-]+)\.(yaml|yml)$/.exec(base);
  if (!match) return false;
  const [, docStem, tag] = match;
  if (!docStem || !tag || !TRANSLATION_METADATA_TAGS.has(tag.toLowerCase())) return false;
  const dir = posix.dirname(filePath);
  const companionBase = dir === "." ? docStem : `${dir}/${docStem}`;
  return repositoryFiles.has(`${companionBase}.md`) || repositoryFiles.has(`${companionBase}.mdx`);
}

export interface ImpactAnalyzeOptions {
  /** Repo-relative paths of every file present at HEAD (e.g. `git ls-tree -r --name-only <head>`).
   * Enables relationship-based classification (see isTranslatedDocumentationCompanion). Optional -
   * omitting it disables those rules and keeps prior behavior exactly. */
  repositoryFiles?: ReadonlySet<string>;
  /** Reads a repo-relative file at HEAD (undefined when unreadable, binary or too large). Together with
   * `repositoryFiles` it enables resolving the readers of non-code files by reference
   * (src/repo/file-references.ts). Omitting it keeps such files unknown, exactly as before. */
  readRepositoryFile?: (path: string) => string | undefined;
  /** Let a file the root test script runs directly be covered by running that phase
   * (ImpactResult.testPhases) instead of falling back. Only for callers that execute the phases. */
  selectTestPhases?: boolean;
}

function changedFileReasons(file: ChangedFile): ImpactReason[] {
  switch (file.changeType) {
    case "added": return ["DIRECT_CHANGE"];
    case "deleted": return ["DIRECT_CHANGE", "DELETED_FILE_LEGACY_DEPENDENTS"];
    case "renamed": return ["DIRECT_CHANGE", "RENAMED_FILE_LEGACY_IDENTITY"];
    default: return ["DIRECT_CHANGE"];
  }
}

export interface AlwaysRunCheck {
  name: string;
  reason: ImpactReason;
  /** Regular expressions, for checks constructed in code. */
  patterns: RegExp[];
  /** Globs, for checks a repository declares about itself (src/repo/repo-config.ts). */
  globs?: string[];
}

/**
 * No always-run policy by default (Phase 01 follow-up, 2026-08-26).
 *
 * This was a list of three checks matching `test-security.js`, `test-api-guardrails`, `verify-*.test.`
 * and `scripts/*.test.mjs` - DiffCI's and DentalPresence's own file names, compiled into the engine and
 * applied to every repository analysed. On any other repository they matched nothing, so the policy was
 * a repo-specific default that was also dead weight everywhere else.
 *
 * The policy is worth having; the list belongs to the repository. A repository declares its own via
 * `diffci.alwaysRunTests` in package.json or a `diffci.json` (src/repo/repo-config.ts), and this
 * repository declares its three there. Absent configuration means no always-run policy rather than a
 * guessed one.
 */
export const DEFAULT_ALWAYS_RUN_CHECKS: AlwaysRunCheck[] = [];

/** Turns the repository's declared always-run globs into a check, so the policy is applied by exactly
 * the same code path as an explicitly-constructed one. */
function alwaysRunChecksFromProfile(profile: RepositoryProfile): AlwaysRunCheck[] {
  const globs = profile.diffciConfig?.alwaysRunTests ?? [];
  if (globs.length === 0) return [];
  return [
    {
      name: "repository-declared",
      reason: "ALWAYS_RUN_POLICY",
      patterns: [],
      globs: [...globs],
    },
  ];
}

export class ImpactAnalyzer {
  private alwaysRunChecks: AlwaysRunCheck[];
  private isTestFile: IsTestFile = DEFAULT_TEST_FILE_MATCHER;
  private layout: RepositoryLayout = UNKNOWN_REPOSITORY_LAYOUT;
  private repositoryFiles: ReadonlySet<string> | undefined;
  private contentCleared: ReadonlySet<string> = new Set();
  private dependencyLockfile: string | undefined;
  private packageJsonSpecifiersOnly = false;
  private specifiersOnlyManifests: ReadonlySet<string> = new Set();
  private exportsRemaps: ReadonlyMap<string, { targets: readonly string[]; dataChanged: boolean }> = new Map();
  private readRepositoryFile: ((path: string) => string | undefined) | undefined;
  private sortedRepositoryFiles: string[] = [];
  private compiledProjectCache: CompiledProject[] | undefined;
  private goEmbedPaths = new Set<string>();
  private selectTestPhases = false;
  private testPhases = new Set<string>();
  private workersOutsideSuite: boolean | undefined;
  private runtimeTestSelection = false;
  /** Export-level bindings (export-reach.ts) and each test's reach under them, per analysis. */
  private bindings: DependencyGraphResult["bindings"];
  private runtimeForward = new Map<string, string[]>();
  private exportReach = new Map<string, Set<string>>();
  private unresolved: readonly UnresolvedDependency[] = [];
  /** Why each changed file the reference resolver could not narrow is unresolvable, for fallbackDetails. */
  private referenceBlockers = new Map<string, string[]>();
  private walkerTests: string[] | undefined;
  private knownTests: string[] | undefined;
  private declaredCovered = new Set<string>();
  /** Go test files grouped by their package's directory value (`profile.goTestPackages` keys are test
   * files; go test files always end `_test.go`). Built once per analysis. */
  private goPackageTestFilesByOwner = new Map<string, string[]>();
  /** Each go-reported package's full file list keyed like `testPackages` (owner itself included). Profiles
   * from the current adapter put a package's test files into `sourcePaths` too, so when this map is
   * populated a package's members are exactly its sourcePaths; legacy cached profiles leave it empty. */
  private goSourceFilesByOwner = new Map<string, string[]>();
  /** Every go-reported package's testdata-reading candidates keyed by its directory: with source
   * metadata the package's members (ordinary sources and test files, a package without tests of its
   * own included — helpers there read other packages' testdata for their callers' tests); legacy
   * cached profiles only ever knew the listed tests. The cross-package scan checks every package's
   * entry except the owner (2026-11-09, review of #85). */
  private goReadersByPackage = new Map<string, string[]>();
  /** Repository files that no go-reported package reported — code outside package discovery whose
   * references to a package's testdata disqualify the selective route like a cross-package one:
   * tests in nested modules or other languages, ordinary `.go` files excluded from package
   * discovery, and non-test source modules in a mixed repository. Their readers run with a
   * different working directory, so the package-owned convention cannot hold for them. */
  private goOutsideReaders = new Set<string>();
  /** A changed `testdata/` path selects its owning package's tests when the parent directory is a Go
   * package with tests and no other package's test file names it by reference; every other
   * discovery-excluded path keeps full validation. */
  private goPackageTestDataOwner = new Map<string, string>();

  /** Test files known to the graph: nodes matching the profile's test globs or the test-file matcher. */
  private knownTestPaths(profile: RepositoryProfile, graph: DependencyGraph): string[] {
    if (this.knownTests) return this.knownTests;
    const known = new Set<string>();
    for (const testLocation of profile.tests) {
      for (const node of graph.nodes) {
        if (matchesTestGlob(node.path, testLocation.glob) || this.isTestFile(node.path)) known.add(node.path);
      }
    }
    this.knownTests = [...known].sort();
    return this.knownTests;
  }

  /**
   * The tests the repository's declared inputs (src/repo/repo-config.ts, `inputs`) select for a changed
   * path, or undefined when no declaration names the path (2026-11-05). An empty array means a declaration
   * names it but its `tests` globs match nothing: a stale declaration, which must not stand in for evidence.
   */
  private declaredTests(path: string, profile: RepositoryProfile, graph: DependencyGraph): string[] | undefined {
    const inputs = (profile.diffciConfig?.inputs ?? []).filter((input) => input.files.some((glob) => matchesTestGlob(path, glob)));
    if (inputs.length === 0) return undefined;
    const globs = inputs.flatMap((input) => input.tests);
    // Go profiles declare no test locations (`profile.tests` is a JS-runner notion), so the go
    // adapter's package-reported `_test.go` files join the candidates; without them a declaration
    // naming any Go path is always stale and files the very fallback the declaration was meant to
    // override. They are additional candidates behind globs the repository names - nothing is
    // selected that the declaration did not ask for (2026-11-09, issue #83).
    const goTestCandidates = profile.adapters?.some(adapter => adapter.id === "go")
      ? Object.keys(profile.goTestPackages ?? {}).filter(test => test.endsWith("_test.go"))
      : [];
    return [...this.knownTestPaths(profile, graph), ...goTestCandidates].filter((test) => globs.some((glob) => matchesTestGlob(test, glob)));
  }

  /**
   * Groups the Go adapter's test files by their package's directory and maps each changed
   * `testdata/` path to its owning package (`testdata` is excluded from package discovery, so go
   * list cannot report this ownership itself; the go tool runs a package's tests with its
   * directory as the working directory, which is the convention the path follows). Paths that
   * qualify select that package's tests for the changed path instead of full validation; a legacy
   * cached profile without test-package evidence, repository contents being unavailable, a parent
   * directory that is no Go package with tests, `_`-prefixed or `.`-prefixed directories, or
   * another package naming the path or its `testdata` directory by literal reference (its test
   * files or ordinary sources, a helper package with no tests of its own included, or a source
   * module outside the go-reported packages; also, a `_`/`.`-prefixed directory inside the
   * testdata tree) leave the fallback as before.
   */
  private mapGoPackageTestData(delta: GitDelta, profile: RepositoryProfile): Map<string, string> {
    this.goPackageTestDataOwner = new Map();
    const byOwner = new Map<string, string[]>();
    for (const [test, owner] of Object.entries(profile.goTestPackages ?? {})) {
      if (!test.endsWith("_test.go")) continue;
      const tests = byOwner.get(owner);
      if (tests) tests.push(test);
      else byOwner.set(owner, [test]);
    }
    this.goPackageTestFilesByOwner = byOwner;
    // The current go adapter puts each package's test files into `sourcePaths`, so with source
    // metadata a package's members are exactly its sourcePaths and the test-file grouping only
    // stands in for it.
    this.goSourceFilesByOwner = new Map<string, string[]>();
    const knownSources = new Set<string>();
    for (const source of profile.goDependencyPaths?.sources ?? []) {
      knownSources.add(source);
      const dir = source.slice(0, source.lastIndexOf("/"));
      const pkg = dir ? `./${dir}` : ".";
      const members = this.goSourceFilesByOwner.get(pkg);
      if (members) members.push(source);
      else this.goSourceFilesByOwner.set(pkg, [source]);
    }
    // The cross-package scan checks every go-reported package's readers, not only packages with
    // tests: a helper in an ordinary `.go` file of a package with no tests of its own (the
    // `testutil/golden.go` pattern) can read a package's testdata on behalf of its callers' tests,
    // and such a package never enters the test-file grouping (2026-11-09, review of #85). With
    // source metadata a package's readers are its sourcePaths (which include its test files);
    // legacy cached profiles only ever knew the listed tests, so their entries keep just those.
    this.goReadersByPackage = new Map();
    for (const pkg of new Set([...this.goSourceFilesByOwner.keys(), ...byOwner.keys()])) {
      const sourceFiles = this.goSourceFilesByOwner.get(pkg);
      const testFiles = byOwner.get(pkg);
      if (sourceFiles?.length) {
        this.goReadersByPackage.set(pkg, testFiles?.length ? [...new Set([...sourceFiles, ...testFiles])] : sourceFiles);
      } else {
        this.goReadersByPackage.set(pkg, testFiles ?? []);
      }
    }
    // And readers outside every go-reported package (tests in nested modules or other languages,
    // ordinary `.go` files excluded from package discovery, and non-test source modules in a mixed
    // repository) can name a package's testdata directly; they run with a different working
    // directory, so the package-owned convention cannot hold and such a reference disqualifies
    // the selective route (2026-11-09, review of #85).
    const reportedGoTests = new Set(Object.keys(profile.goTestPackages ?? {}));
    const pythonSources = new Set(profile.pythonSources ?? []);
    this.goOutsideReaders = new Set((this.sortedRepositoryFiles ?? []).filter(file =>
      !knownSources.has(file) && !reportedGoTests.has(file)
      && (isSourceFilePath(file) || pythonSources.has(file) || this.isTestFile(file))));
    if (!profile.goTestPackages || !this.readRepositoryFile) return this.goPackageTestDataOwner;
    const readRepositoryFile = this.readRepositoryFile;
    for (const path of new Set(delta.files.flatMap(allChangePaths))) {
      const owner = this.goPackageTestDataOwnerFor(path, byOwner, readRepositoryFile);
      if (owner !== undefined) this.goPackageTestDataOwner.set(path, owner);
    }
    return this.goPackageTestDataOwner;
  }

  private goPackageTestDataOwnerFor(
    path: string,
    byOwner: ReadonlyMap<string, string[]>,
    readRepositoryFile: (path: string) => string | undefined,
  ): string | undefined {
    const segments = path.split("/");
    const at = segments.indexOf("testdata");
    if (at === -1) return undefined;
    // An embedded testdata file is a production runtime input, not only test input: it keeps the
    // embed fallback, and never takes the package-owned test data route.
    if (this.goEmbedPaths.has(path)) return undefined;
    // Only `testdata` gets the package convention: discovery-excluded directory names around it
    // (both on the way to the package and inside the testdata tree) keep the fallback.
    const ignored = (segment: string) => segment === "" || segment.startsWith("_") || segment.startsWith(".");
    if (segments.slice(0, at).some(ignored) || segments.slice(at + 1).some(ignored)) return undefined;
    const owner = segments.slice(0, at).length === 0 ? "." : `./${segments.slice(0, at).join("/")}`;
    const tests = byOwner.get(owner);
    if (!tests?.length) return undefined;
    const dataDir = [...segments.slice(0, at), "testdata"].join("/");
    const filePattern = referencePattern(referenceTokens(path));
    const dirPattern = referencePattern(referenceTokens(dataDir));
    const disqualifies = (reader: string): boolean => {
      const content = readRepositoryFile(reader);
      // A listed test file that cannot be read could still name the testdata; without its
      // contents the conservative answer is no selective route at all.
      if (content === undefined) return true;
      const references = isGoReaderFile(reader) ? goReaderReferences(content) : content;
      return contentNamesPath(references, reader, path, filePattern, true)
          || contentNamesPath(references, reader, dataDir, dirPattern, true);
    };
    for (const [pkg, readers] of this.goReadersByPackage) {
      if (pkg === owner) continue;
      if (readers.some(disqualifies)) return undefined;
    }
    // Readers outside the go-reported packages (tests of nested modules or other languages, ordinary
    // `.go` files outside package discovery, non-test source modules in a mixed repository) never
    // take the package-owned convention, since their tests run with a different working directory;
    // a reference there disqualifies the selective route exactly like a cross-package one
    // (2026-11-09, review of #85).
    if ([...this.goOutsideReaders].some(disqualifies)) return undefined;
    return owner;
  }

  /** Dependents whose tests a change to `path` can affect. When the graph allows runtime selection
   * (DependencyGraphResult.runtimeTestSelection) an `import type` edge selects only type tests. */
  private testDependents(graph: DependencyGraph, path: string, dependents: readonly string[]): ReadonlySet<string> {
    if (!this.runtimeTestSelection || !graph.transitiveRuntimeDependentsOf) return new Set(dependents);
    const selected = new Set(graph.transitiveRuntimeDependentsOf(path));
    for (const dependent of dependents) if (TYPE_TEST_FILE.test(dependent)) selected.add(dependent);
    return selected;
  }

  /** Drops tests whose imports never reach `path` by name (export-reach.ts). Without bindings (older
   * caches) the file-level set stands. */
  private exportLevelTests(path: string, tests: ReadonlySet<string>, evidence: ImpactEvidence[]): ReadonlySet<string> {
    // Type tests (`*.test-d.ts`, tstyche's `*.tst.ts`) check types, which the walk does not narrow.
    const bindings = this.bindings;
    if (!bindings) return tests;
    const kept = new Set<string>();
    const droppedTests: string[] = [];
    let reaching = 0;
    for (const test of tests) {
      if (!this.isTestFile(test) || TYPE_TEST_FILE.test(test) || TYPE_CHECK_TEST_FILE.test(test)) { kept.add(test); continue; }
      let reach = this.exportReach.get(test);
      if (!reach) {
        reach = exportLevelReach(test, bindings, (file) => this.runtimeForward.get(file) ?? [], !this.runtimeTestSelection);
        this.exportReach.set(test, reach);
      }
      if (reach.has(path)) { kept.add(test); reaching++; } else droppedTests.push(test);
    }
    if (!droppedTests.length) return kept;
    // A barrel still loads every module it re-exports, so an error thrown while `path` loads fails every
    // importer, used names or not. Any test that reaches `path` by name shows such an error; when none does,
    // keep one dropped test to load it.
    if (reaching === 0) kept.add(droppedTests.sort()[0]!);
    const skipped = droppedTests.length - (reaching === 0 ? 1 : 0);
    if (skipped) evidence.push(makeEvidence("DEPENDENCY", path, `${skipped} test(s) import ${path} only through re-exports of names they do not use, in side-effect-free packages (export-level selection)${reaching === 0 ? `; ${droppedTests[0]} is kept to load it` : ""}`));
    return kept;
  }

  /** True when nothing in the repository runs a Worker (file-references.ts, suiteMayRunWorkers); false,
   * which keeps wrangler configs global, whenever repository contents are unavailable. */
  private workerConfigsOutsideSuite(): boolean {
    if (this.workersOutsideSuite === undefined) {
      this.workersOutsideSuite = Boolean(this.repositoryFiles && this.readRepositoryFile)
        && !suiteMayRunWorkers(this.sortedRepositoryFiles, this.readRepositoryFile!, isSourceFilePath);
    }
    return this.workersOutsideSuite;
  }
  constructor(alwaysRunChecks: AlwaysRunCheck[] = DEFAULT_ALWAYS_RUN_CHECKS) { this.alwaysRunChecks = alwaysRunChecks; }

  analyze(delta: GitDelta, graphResult: DependencyGraphResult, profile: RepositoryProfile, options: ImpactAnalyzeOptions = {}): ImpactResult {
    const start = process.hrtime.bigint();
    const { graph } = graphResult;
    this.isTestFile = testFileMatcherForProfile(profile);
    this.layout = repositoryLayout(profile);
    this.repositoryFiles = options.repositoryFiles;
    this.selectTestPhases = options.selectTestPhases === true;
    this.testPhases = new Set();
    this.workersOutsideSuite = undefined;
    this.walkerTests = undefined;
    this.knownTests = undefined;
    this.declaredCovered = new Set();
    this.runtimeTestSelection = graphResult.runtimeTestSelection === true;
    this.bindings = graphResult.bindings;
    this.exportReach = new Map();
    this.runtimeForward = new Map();
    // Where tests may be type-checked as they run (no runtime test selection: Jest, ts-jest, tstyche, tsd,
    // --typecheck), a type import can fail a test too, so the walk follows it as a whole-module edge.
    if (this.bindings) for (const edge of graph.edges) {
      if (edge.kind === "asset" || (edge.kind === "type-import" && this.runtimeTestSelection)) continue;
      const targets = this.runtimeForward.get(edge.from);
      if (targets) { if (!targets.includes(edge.to)) targets.push(edge.to); } else this.runtimeForward.set(edge.from, [edge.to]);
    }
    this.unresolved = graphResult.unresolved ?? [];
    this.referenceBlockers = new Map();
    this.sortedRepositoryFiles = options.repositoryFiles ? [...options.repositoryFiles].sort() : [];
    this.compiledProjectCache = undefined;
    // One read per file per analysis, however many changed files ask who reads them.
    const read = options.readRepositoryFile;
    const contents = new Map<string, string | undefined>();
    this.readRepositoryFile = read && ((path: string) => {
      if (!contents.has(path)) contents.set(path, read(path));
      return contents.get(path);
    });
    const referenceResolved = new Set(delta.analysis.referenceResolvedPaths ?? []);
    this.contentCleared = referenceResolved;
    this.dependencyLockfile = delta.analysis.dependencyLockfile;
    this.packageJsonSpecifiersOnly = delta.analysis.packageJsonSpecifiersOnly === true;
    this.specifiersOnlyManifests = new Set(delta.analysis.specifiersOnlyManifests ?? []);
    this.exportsRemaps = new Map(Object.entries(delta.analysis.exportsRemaps ?? {}));
    const changedImpacts: ChangedImpact[] = delta.files.map((file) => ({ file, category: classifyChangedFile(file, this.isTestFile, this.layout, options.repositoryFiles, referenceResolved, new Set(profile.pythonSources ?? [])), reasons: changedFileReasons(file) }));
    const evidence: ImpactEvidence[] = [];
    const riskSignals: ImpactRiskSignal[] = [];
    const fallbackReasons: string[] = [...(graphResult.adapterBlockers ?? []), ...testDiscoveryErrors(profile)];
    if (profile.vueScope) {
      const scope = profile.vueScope;
      if (delta.files.some(file => allChangePaths(file).some(path => !inVuePackage(path, scope.packageRoot)))) fallbackReasons.push("Changes outside the declared Vue package require full validation");
      const setupDependencies = new Set((profile.vueSetupPaths ?? []).flatMap(path => [path, ...graph.transitiveDependenciesOf(path)]));
      if (delta.files.some(file => allChangePaths(file).some(path => setupDependencies.has(path)))) fallbackReasons.push("Vue suite configuration or shared setup dependency changed; full validation required");
    }
    const hasGoAdapter = profile.adapters?.some(adapter => adapter.id === "go");
    this.goEmbedPaths = new Set(hasGoAdapter ? profile.goDependencyPaths?.embeds : []);
    const goPackageTestDataOwner = hasGoAdapter ? this.mapGoPackageTestData(delta, profile) : new Map<string, string>();
    if (hasGoAdapter) {
      // go list models package sources and embeds, not arbitrary runtime reads. Neither a
      // familiar extension/directory nor membership in another adapter's graph proves ownership.
      // Check both identities of renames/copies, including files absent from the HEAD inventory.
      // Missing metadata in older cached profiles deliberately fails closed as well.
      const modeledPaths = new Set([...(profile.goDependencyPaths?.sources ?? []), ...this.goEmbedPaths]);
      const unmodeledPaths = [...new Set(delta.files.flatMap(allChangePaths))]
        .filter(path => !modeledPaths.has(path) && !goPackageTestDataOwner.has(path));
      if (unmodeledPaths.length) fallbackReasons.push(`Go runtime inputs outside source/embed metadata require full validation: ${unmodeledPaths.slice(0, 20).join(", ")}`);
    }
    if (hasGoAdapter && delta.files.some(file => allChangePaths(file).some(path => isGoDiscoveryIgnoredPath(path) && !goPackageTestDataOwner.has(path)))) {
      fallbackReasons.push("Changes in Go discovery-excluded paths require full validation, including runtime test data");
    }
    const excludedGoRoots = profile.goExcludedModuleRoots ?? [];
    if (delta.files.some(file => allChangePaths(file).some(path => excludedGoRoots.some(root => path.startsWith(root))))) {
      fallbackReasons.push("Changes in a Go module outside the declared root-module scope require full validation");
    }
    for (const file of delta.files) {
      if (allChangePaths(file).some((path) => /(?:^|\/)(?:diffci\.json|go\.(?:mod|sum|work)|go\.work\.sum|(?:vite|vue|nuxt)\.config\.[^/]+)$/.test(path))) {
        fallbackReasons.push(`Language/framework configuration changed: ${file.path}`);
      }
    }

    // Declared inputs (2026-11-05): a changed path a declaration names, with at least one test behind it,
    // is covered - its tests are selected below instead of the unknown-file or database/infrastructure
    // fallback. A declaration whose tests match nothing is stale and falls back.
    for (const path of new Set(delta.files.flatMap(allChangePaths))) {
      const tests = this.declaredTests(path, profile, graph);
      if (tests === undefined) continue;
      if (tests.length > 0) { this.declaredCovered.add(path); continue; }
      const message = `Declared input ${path} selects no tests; full validation required`;
      riskSignals.push({ level: "critical", reason: "DECLARED_INPUT", message, paths: [path] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
    }

    this.applyGlobalRiskRules(delta, riskSignals, fallbackReasons);

    // Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): refine the graph's raw,
    // delta-independent confidence to THIS delta's changed files - see refineConfidenceForDelta()'s doc
    // comment in graph.ts for the full reasoning and what is (and is deliberately NOT) narrowed.
    const changedPaths = delta.files.flatMap((f) => allChangePaths(f));
    // A blocker confined to package directories names itself only when this delta reaches one of them.
    for (const blocker of relevantScopedAdapterBlockers(graphResult, changedPaths)) {
      if (!fallbackReasons.includes(blocker.reason)) fallbackReasons.push(blocker.reason);
    }
    const effectiveGraphConfidence = refineConfidenceForDelta(graphResult, changedPaths);

    if (effectiveGraphConfidence === "UNSAFE") {
      const message = "Dependency graph confidence is UNSAFE; full validation required";
      riskSignals.push({ level: "critical", reason: "GRAPH_CONFIDENCE_UNSAFE", message });
      fallbackReasons.push(message);
    }

    // Phase 01 F1 (2026-08-26): a repository that declares a test framework and in which discovery
    // found no test file at all is a repository whose test layout the engine does not understand.
    // Every downstream consumer reads an empty selection as "nothing needs to run", so without this
    // the engine is at its most confident exactly where it is most blind. Measured on immerjs/immer,
    // whose entire `__tests__/` suite was invisible: graph confidence COMPLETE, 5 of 5 commits
    // SELECTIVE, zero tests. Fails closed to FULL instead.
    if (profile.testUniverse?.blindSpot === true) {
      const declared = profile.testUniverse.declaredFrameworks.join(", ");
      const message = `Repository declares ${declared} but no test files were discovered; full validation required`;
      riskSignals.push({ level: "critical", reason: "TEST_UNIVERSE_EMPTY", message });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
    }

    if (delta.files.length === 0) {
      riskSignals.push({ level: "info", reason: "EMPTY_DELTA", message: "Empty delta; nothing to analyze" });
    }

    const affectedSources = new Map<string, ImpactEvidence[]>();
    const affectedAssets = new Map<string, ImpactEvidence[]>();
    const affectedEntryPoints = new Map<string, EntryPointImpact>();
    const affectedTests = new Map<string, TestImpact>();
    const affectedScripts = new Map<string, ImpactEvidence[]>();

    for (const changedImpact of changedImpacts) {
      for (const path of allChangePaths(changedImpact.file)) {
        this.processChangedPath(path, changedImpact, graph, profile, affectedSources, affectedAssets, affectedEntryPoints, affectedTests, affectedScripts, evidence, riskSignals, fallbackReasons);
      }
    }

    this.collectTestScriptAdditions(delta, graph, affectedTests, evidence, riskSignals, fallbackReasons);
    this.collectDependencyChangeTests(delta, graphResult, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, riskSignals, fallbackReasons);
    this.handleStructuralNextLayout(changedImpacts, profile, affectedEntryPoints, affectedSources, evidence);
    this.handleAddedEntryPoints(delta, affectedEntryPoints, affectedSources, affectedTests, evidence, fallbackReasons);
    this.collectRouteVisitTests(profile, graph, affectedEntryPoints, affectedTests, evidence);
    this.collectAlwaysRunTests(profile, graph, affectedTests, evidence, graphResult.profile.vueRuntimeAlwaysRunPaths ?? []);
    this.collectComputedImportTests(graphResult, graph, changedImpacts, affectedTests, evidence, riskSignals, fallbackReasons);

    // Changed-test self-selection invariant (2026-08-24): every executable directly-changed test
    // (added / modified / renamed-destination / copied-destination) MUST be present in the final
    // selected-test set. This is a defense-in-depth guard over the traversal above so a selection
    // regression cannot silently authorize a SAFE_TO_PROPOSE that would skip a just-edited test.
    const directlyChangedTests = directlyChangedExecutableTests(delta, this.isTestFile);
    const selectedTestPaths = new Set(affectedTests.keys());
    const missingSelectedTests = directlyChangedTests.filter((t) => !selectedTestPaths.has(t));
    if (missingSelectedTests.length > 0) {
      const message = `Changed test selection invariant violated: ${missingSelectedTests.length} directly changed test(s) not selected (${missingSelectedTests.join(", ")})`;
      riskSignals.push({ level: "critical", reason: "TEST_SELECTION_INVARIANT", message, paths: missingSelectedTests });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
    }

    // The same blind spot inside one workspace package (2026-11-09, Sentry): node-integration-tests runs
    // `vitest run` on `./**/test.ts` from a vite.config.ts DiffCI does not read, so its 277 tests were plain
    // source. A change reaching that package selected none of them, not even the changed one. A changed or
    // affected file inside a package whose own test script runs a framework with no discovered test falls back.
    for (const { packageRoot, profile: child } of profile.workspaceTestPackages ?? []) {
      if (child.testUniverse?.blindSpot !== true) continue;
      const prefix = `${packageRoot}/`;
      const reached = [...changedPaths, ...affectedSources.keys(), ...affectedTests.keys()].some((path) => path.startsWith(prefix));
      if (!reached) continue;
      const message = `Workspace package ${packageRoot} declares ${child.testUniverse.declaredFrameworks.join(", ")} but no test files were discovered in it; full validation required`;
      riskSignals.push({ level: "critical", reason: "WORKSPACE_TEST_UNIVERSE_EMPTY", message });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
    }

    // 2026-10-21: affected tests that `npm test` never runs are not part of the full suite, so they are
    // reported beside the selection rather than inside it (src/repo/script-universe.ts). They have
    // already satisfied the changed-test invariant above and are still meant to be run.
    const fullSuite = this.fullSuiteUniverse(profile, graph);
    const testsOutsideFullSuite: TestImpact[] = [];
    if (fullSuite?.complete) {
      const inside = new Set(fullSuite.tests);
      for (const [path, impact] of affectedTests) {
        if (inside.has(path)) continue;
        testsOutsideFullSuite.push(impact);
        affectedTests.delete(path);
        evidence.push(makeEvidence("OUTSIDE_FULL_SUITE", path, `${path} is not run by the test script; reported outside the full suite`));
      }
    }

    const fallbackRequired = effectiveGraphConfidence === "UNSAFE" || fallbackReasons.length > 0;
    const analysisStatus: ImpactResult["analysisStatus"] = fallbackRequired ? "FALLBACK" : "SAFE_TO_PROPOSE";
    const dedupedRiskSignals = Array.from(
      new Map(riskSignals.map((s) => [s.reason, s])).values(),
    ).sort((a, b) => a.reason.localeCompare(b.reason));

    return {
      changedFiles: changedImpacts,
      affectedSourceFiles: Array.from(affectedSources.keys()).sort(),
      affectedAssets: Array.from(affectedAssets.keys()).sort(),
      affectedTests: Array.from(affectedTests.values()).sort((a, b) => a.path.localeCompare(b.path)),
      ...(fullSuite?.complete ? {
        fullSuiteTestCount: fullSuite.tests.length,
        testsOutsideFullSuite: testsOutsideFullSuite.sort((a, b) => a.path.localeCompare(b.path)),
      } : {}),
      ...(this.testPhases.size ? { testPhases: [...this.testPhases].sort() } : {}),
      affectedEntryPoints: Array.from(affectedEntryPoints.values()).sort((a, b) => a.path.localeCompare(b.path)),
      affectedScripts: Array.from(affectedScripts.keys()).sort(),
      riskSignals: dedupedRiskSignals,
      fallbackRequired,
      fallbackReasons,
      ...(fallbackRequired && this.referenceBlockers.size ? { fallbackDetails: this.fallbackDetails(fallbackReasons) } : {}),
      analysisStatus,
      effectiveGraphConfidence,
      evidence: evidence.sort((a, b) => { const c = a.changedFile.localeCompare(b.changedFile); if (c !== 0) return c; return a.message.localeCompare(b.message); }),
      performance: { durationMs: Number(process.hrtime.bigint() - start) / 1_000_000 },
    };
  }

  /** Blockers of each file a fallback reason names, at most 20 files and 10 blockers each. */
  private fallbackDetails(fallbackReasons: readonly string[]): Record<string, string[]> {
    const details: Record<string, string[]> = {};
    for (const [path, blockers] of [...this.referenceBlockers].sort(([a], [b]) => a.localeCompare(b))) {
      if (Object.keys(details).length >= 20) break;
      if (fallbackReasons.some((reason) => reason.includes(path))) details[path] = blockers.slice(0, 10);
    }
    return details;
  }

  private applyGlobalRiskRules(delta: GitDelta, riskSignals: ImpactRiskSignal[], fallbackReasons: string[]): void {
    type SignalKey = keyof NonNullable<GitDelta["analysis"]["signalPaths"]>;
    const reasons: Array<{ reason: ImpactReason; message: string; signal: SignalKey; check: (a: GitDelta["analysis"]) => boolean }> = [
      { reason: "CONFIG_GLOBAL", message: "Configuration file(s) changed; full validation required", signal: "config", check: (a) => a.configChanged },
      { reason: "DEPENDENCY_MANIFEST", message: "Dependency manifest changed; full validation required", signal: "dependencyManifest", check: (a) => a.dependencyManifestChanged },
      { reason: "LOCKFILE_GLOBAL", message: "Lockfile changed; full validation required", signal: "lockfile", check: (a) => a.lockfileChanged },
      { reason: "WORKFLOW_GLOBAL", message: "CI workflow definition(s) changed; full validation required", signal: "workflow", check: (a) => a.workflowChanged },
      { reason: "INFRASTRUCTURE_GLOBAL", message: "Infrastructure definition(s) changed; full validation required", signal: "infrastructure", check: (a) => a.infrastructureChanged },
      { reason: "DATABASE_GLOBAL", message: "Database definition(s) changed; full validation required", signal: "database", check: (a) => a.databaseChanged },
    ];
    for (const rule of reasons) {
      if (rule.check(delta.analysis)) {
        // The stable sentence stays a prefix, so consumers that categorise by it keep working; the
        // files that triggered it follow (2026-10-21).
        let paths = delta.analysis.signalPaths?.[rule.signal] ?? [];
        if (rule.signal === "infrastructure" && paths.length > 0 && this.workerConfigsOutsideSuite()) {
          // A wrangler config cannot reach a suite that never runs a Worker; processChangedPath resolves
          // its readers instead (2026-10-29).
          paths = paths.filter((path) => !isWorkerConfig(path));
          if (paths.length === 0) continue;
        }
        if ((rule.signal === "infrastructure" || rule.signal === "database") && paths.length > 0) {
          // A database or deployment definition the repository declared inputs for selects those tests in
          // processChangedPath. Configuration, manifests, lockfiles and workflows stay global (2026-11-05).
          paths = paths.filter((path) => !this.declaredCovered.has(path));
          if (paths.length === 0) continue;
        }
        const message = paths.length === 0 ? rule.message
          : `${rule.message}: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}`;
        riskSignals.push({ level: "critical", reason: rule.reason, message, ...(paths.length ? { paths: [...paths] } : {}) });
        if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      }
    }
  }

  /** A test file a test-list edit added to the test script now runs as part of the suite, whether or
   * not it changed (src/git/git-diff.ts, testListEdit). One that is missing at HEAD would make the
   * script fail, so it falls back. */
  private collectTestScriptAdditions(delta: GitDelta, graph: DependencyGraph, affectedTests: Map<string, TestImpact>, evidence: ImpactEvidence[], riskSignals: ImpactRiskSignal[], fallbackReasons: string[]): void {
    for (const path of delta.analysis.testScriptAddedPaths ?? []) {
      if (this.repositoryFiles && !this.repositoryFiles.has(path)) {
        const message = `package.json test script now lists ${path}, which does not exist; full validation required`;
        riskSignals.push({ level: "critical", reason: "DEPENDENCY_MANIFEST", message, paths: ["package.json"] });
        if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
        continue;
      }
      this.addAffectedTest("package.json", path, graph, affectedTests, "NEW_TEST_FILE", evidence);
      evidence.push(makeEvidence("NEW_TEST_FILE", "package.json", `package.json test script now runs ${path}`, path));
    }
  }

  /**
   * Selects the tests that load each direct dependency whose installed tree changed
   * (GitDeltaAnalysis.changedDependencies, 2026-10-28). A package reaches a test only by being loaded:
   * imported by graph code, which selects the importer's dependent tests; imported by code outside the
   * graph, whose own readers are resolved by reference; or loaded by tooling, which this cannot see.
   * So the change falls back when no repository code imports the package (a CLI, a plugin, `@types/*`),
   * when a test-closure script names it, or when a file tooling loads implicitly names it (a config
   * that registers a plugin or a preset).
   */
  private collectDependencyChangeTests(
    delta: GitDelta,
    graphResult: DependencyGraphResult,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
    riskSignals: ImpactRiskSignal[],
    fallbackReasons: string[],
  ): void {
    const packages = delta.analysis.changedDependencies;
    if (!packages || packages.length === 0) return;
    const { graph } = graphResult;
    const yarnCandidates = delta.analysis.dependencyLockfile === "yarn.lock";
    const changedFile = delta.analysis.dependencyLockfile ?? "package.json";
    const dependencyChange = (name: string) => yarnCandidates
      ? `Dependency ${name} may be affected by the Yarn lockfile change` : `Dependency ${name} changed`;
    const fail = (message: string) => {
      riskSignals.push({ level: "critical", reason: "DEPENDENCY_MANIFEST", message, paths: [changedFile] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
    };
    // Typecheck and build tasks still see a dependency change (planner globalRiskTriggers).
    riskSignals.push({ level: "info", reason: "DEPENDENCY_MANIFEST", message: yarnCandidates
      ? `Dependencies potentially affected by Yarn lockfile change: ${packages.join(", ")}`
      : `Dependencies changed: ${packages.join(", ")}`, paths: [changedFile] });
    if (!this.repositoryFiles || !this.readRepositoryFile) {
      fail(`${yarnCandidates ? "Potential dependency impact" : "Dependency change"} (${packages.join(", ")}) cannot be traced without repository contents; full validation required`);
      return;
    }
    const packageRoot = (specifier: string) => {
      const parts = specifier.split("/");
      return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    };
    if (yarnCandidates) {
      // Classic can hoist transitive packages that repository code imports without declaring them.
      // All-root widening covers peers, but cannot attribute these additional importers to a root.
      const undeclared = [...new Set(graphResult.references.filter((ref) => ref.resolution === "external-package")
        .map((ref) => packageRoot(ref.specifier)).filter((name) => !packages.includes(name)))].sort();
      if (undeclared.length) fail(`Yarn lockfile changed and repository imports undeclared dependencies (${undeclared.join(", ")}); full validation required`);
    }
    if (delta.analysis.dependencyLockfile === "pnpm-lock.yaml") {
      // pnpm is strict by default, but `public-hoist-pattern` and a hoisted node-linker expose
      // transitive packages at the root. An undeclared import of one is not attributed to a root.
      const declared = new Set([...profile.packageJson.dependencies, ...profile.packageJson.devDependencies]);
      const undeclared = [...new Set(graphResult.references.filter((ref) => ref.resolution === "external-package")
        .map((ref) => packageRoot(ref.specifier)).filter((name) => !declared.has(name)))].sort();
      if (undeclared.length) fail(`pnpm lockfile changed and repository imports undeclared dependencies (${undeclared.join(", ")}); full validation required`);
    }
    const scripts = profile.packageJson.scripts;
    const closureBodies = [...testScriptClosure(scripts)].map((name) => scripts[name] ?? "");
    for (const name of packages) {
      const importers = [...new Set(graphResult.references
        .filter((ref) => ref.resolution === "external-package" && packageRoot(ref.specifier) === name)
        .map((ref) => ref.importer))].sort();
      if (importers.length === 0) {
        const blocker = this.resolveUnimportedPackage(name, changedFile, closureBodies, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
        if (blocker) {
          evidence.push(makeEvidence("DEPENDENCY", changedFile, `${name}: ${blocker}`));
          fail(`${dependencyChange(name)} and no repository source imports it; full validation required`);
        }
        continue;
      }
      const quoted = new RegExp(`["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/[^"'\`]*)?["'\`]`);
      const bare = new RegExp(`(?:^|[\\s"'=])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"'/@])`);
      if (closureBodies.some((body) => bare.test(body))) {
        fail(`${dependencyChange(name)} and the test script runs it; full validation required`);
        continue;
      }
      const toolingReader = this.sortedRepositoryFiles.find((path) => isImplicitlyLoadedFile(path) && !isLockfile(path) && compilerConfigNames(path, this.readRepositoryFile!(path) ?? "", quoted));
      if (toolingReader) {
        fail(`${dependencyChange(name)} and ${toolingReader} loads it; full validation required`);
        continue;
      }
      for (const importer of importers) {
        evidence.push(makeEvidence("DEPENDENCY", changedFile, `${importer} imports ${yarnCandidates ? "potentially affected" : "changed"} dependency ${name}`, importer));
        if (this.isTestFile(importer)) this.addAffectedTest(changedFile, importer, graph, affectedTests, "DEPENDENCY", evidence);
        this.processSourceChange(importer, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
      }
      // Code outside the graph that loads the package reaches the suite only if something runs it.
      for (const path of this.sortedRepositoryFiles) {
        if (!isSourceFilePath(path) || hasNode(graph, path) || !quoted.test(this.readRepositoryFile(path) ?? "")) continue;
        if (!this.resolveByReference(path, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence)) {
          fail(`${dependencyChange(name)} and ${path}, which loads it, is outside the dependency graph; full validation required`);
          break;
        }
      }
    }
  }

  /**
   * A changed dependency no repository code imports (2026-11-04). Usually a CLI the repository runs by
   * its executable's name: bumping `@diffci.com/diffci`, run as `diffci`, made all 601 DentalPresence
   * tests run. Such a package reaches the suite only by being run or loaded, so it narrows when
   * package-lock.json records its executables and every file naming the package or one of them
   * resolves: a test is selected, graph code selects its dependent tests, and any other code or
   * directing file must itself resolve by reference. Returns why it cannot narrow: the executables are
   * unknown, the name suggests tooling loads it by convention (types, plugins, presets, test runners),
   * or the test script, a file tooling loads, or a test-feeding workflow step names it.
   */
  private resolveUnimportedPackage(
    name: string,
    changedFile: string,
    closureBodies: readonly string[],
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): string | undefined {
    if (/(?:^@types\/|types|plugin|preset|config|loader|register|polyfill|setup|eslint|prettier|stylelint|babel|postcss|tailwind|jest|vitest|mocha|ava|playwright|cypress|typescript|ts-node|^tsx$|swc|esbuild|vite|webpack|rollup)/i.test(name)) {
      return "tooling may load it by naming convention";
    }
    if (!this.repositoryFiles?.has("package-lock.json")) return "its executables are unknown without package-lock.json";
    let bin: unknown;
    try {
      const lock = JSON.parse(this.readRepositoryFile!("package-lock.json") ?? "") as { packages?: Record<string, { bin?: unknown }> };
      bin = lock.packages?.[`node_modules/${name}`]?.bin;
    } catch { return "package-lock.json could not be parsed"; }
    const bins = typeof bin === "string" ? [name.split("/").pop()!] : bin && typeof bin === "object" ? Object.keys(bin) : [];
    if (bins.length === 0) return "it has no executable, so only tooling can load it";
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(`(?:^|[\\s"'\`=/(])(?:${[name, ...bins].map(escape).join("|")})(?=$|[\\s"'\`/@),;:])`, "m");
    if (closureBodies.some((body) => named.test(body))) return "the test script runs it";
    const scripts = profile.packageJson.scripts;
    for (const path of this.sortedRepositoryFiles) {
      if (path === "package.json" || isLockfile(path) || this.layout.isDocumentationPath(path) || isAgentConfigurationPath(path)) continue;
      const content = this.readRepositoryFile!(path);
      if (content === undefined || !compilerConfigNames(path, content, named)) continue;
      // DiffCI's own config and workflows, for the package providing the `diffci` executable. DiffCI
      // either only observes there or runs the repository's own test command, so its version changes
      // which tests are selected, never their results (2026-11-07: DentalPresence's diffci.config.json
      // and diffci-verify.yml kept the 0.3.34 bump at all 624 tests). A local action may do anything, so
      // it is still checked below.
      if (bins.includes("diffci") && (path === "diffci.config.json" || path.startsWith(".github/workflows/"))) continue;
      if (isImplicitlyLoadedFile(path) || loadsWithoutNaming(path) || posix.basename(path) === "package.json") return `${path} names it and tooling loads that file`;
      if (path.startsWith(".github/")) {
        if (path.startsWith(".github/actions/") || (/^\.github\/workflows\//.test(path) && workflowFeedsTests(content, named, scripts))) return `${path} runs it before tests`;
        continue;
      }
      if (isSourceFilePath(path) && this.isTestFile(path)) {
        evidence.push(makeEvidence("DEPENDENCY", changedFile, `${path} names ${name}`, path));
        this.addAffectedTest(changedFile, path, graph, affectedTests, "DEPENDENCY", evidence);
      } else if (isSourceFilePath(path) && hasNode(graph, path)) {
        evidence.push(makeEvidence("DEPENDENCY", changedFile, `${path} names ${name}`, path));
        this.processSourceChange(path, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
      } else if (isSourceFilePath(path) || DIRECTING_EXTENSIONS.test(path)) {
        if (!this.resolveByReference(path, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, { implicitReadersUnresolvable: true })) {
          return `${path} names it and its own readers could not be resolved`;
        }
      }
    }
    return undefined;
  }

  private processChangedPath(
    changedPath: string,
    changedImpact: ChangedImpact,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedAssets: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
    riskSignals: ImpactRiskSignal[],
    fallbackReasons: string[],
  ): void {
    // Declared inputs add their tests to whatever the graph finds. For a covered path they also stand in
    // for the reader evidence whose absence would otherwise fall back below (2026-11-05).
    for (const test of this.declaredTests(changedPath, profile, graph) ?? []) {
      this.addAffectedTest(changedPath, test, graph, affectedTests, "DECLARED_INPUT", evidence);
    }
    const covered = this.declaredCovered.has(changedPath);
    // An `exports` remap reaches the importers of each subpath it changed, which depend on the subpath's
    // target at HEAD or at the base. A target gone at HEAD is a changed file of this delta or was never
    // importable; one present but outside the graph has unknown importers.
    for (const target of this.exportsRemaps.get(changedPath)?.targets ?? []) {
      if (hasNode(graph, target)) {
        evidence.push(makeEvidence("DEPENDENCY_MANIFEST", changedPath, `${changedPath} remaps an export to ${target}`, target));
        this.processSourceChange(target, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
      } else if (this.repositoryFiles?.has(target) ?? true) {
        const message = `${changedPath} remaps an export to ${target}, which is outside the dependency graph; full validation required`;
        riskSignals.push({ level: "critical", reason: "DEPENDENCY_MANIFEST", message, paths: [changedPath] });
        if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      }
    }
    // Go's embed metadata is ownership evidence regardless of suffix or documentation naming.
    // Traverse it before generic unknown/docs classification can discard the dependency.
    if (this.goEmbedPaths.has(changedPath)) {
      this.processAssetChange(changedPath, graph, profile, affectedAssets, affectedEntryPoints, affectedTests, affectedSources, evidence);
      return;
    }
    // A `testdata/` path whose parent directory is a Go package's is conventionally read by that
    // package's tests. Ownership and cross-references were resolved above, so every path reaching
    // here selects those tests; the loosened cases (no owner package, cross-package readers,
    // discovery-excluded directory names) fell back and never reach this route.
    const goPackageOwner = this.goPackageTestDataOwner.get(changedPath);
    if (goPackageOwner !== undefined) {
      evidence.push(makeEvidence("GO_TESTDATA", changedPath, `${changedPath} is testdata of Go package ${goPackageOwner}`));
      for (const test of this.goPackageTestFilesByOwner.get(goPackageOwner) ?? []) {
        this.addAffectedTest(changedPath, test, graph, affectedTests, "GO_TESTDATA", evidence);
      }
      return;
    }
    // Non-code files are resolved by reference below, directories included; code is not, so a test that
    // lists the directory a code file is in is added here (file-references.ts, directoryWalkers).
    if (isSourceFilePath(changedPath) && this.readRepositoryFile) {
      const read = this.readRepositoryFile;
      this.walkerTests ??= this.sortedRepositoryFiles.filter((path) => this.isTestFile(path) && listsDirectories(read(path)));
      for (const test of directoryWalkers(changedPath, this.walkerTests, this.readRepositoryFile)) {
        if (test === changedPath) continue;
        evidence.push(makeEvidence("FILE_REFERENCE", changedPath, `${test} lists a directory containing ${changedPath}`, test));
        this.addAffectedTest(changedPath, test, graph, affectedTests, "FILE_REFERENCE", evidence);
      }
    }
    const category = changedImpact.category;
    if (changedPath === this.dependencyLockfile) {
      // Dependency selection does not cover a test that reads the lockfile's bytes. Unlike general
      // data, no reader is acceptable here because the package-manager effect was modeled already.
      if (this.resolveByReference(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, { allowNoReaders: true, implicitReadersUnresolvable: true })) return;
      const message = `Lockfile readers could not be resolved: ${changedPath}; full validation required`;
      riskSignals.push({ level: "critical", reason: "LOCKFILE_GLOBAL", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    // A workspace package's manifest edit beyond version and metadata fields (git-diff.ts clears those)
    // changes what the package installs, runs or exports, which reaches every package importing it.
    // Readers that name the file are only the package's own tests, so they cannot bound it (2026-11-03).
    const workspaceManifest = changedPath.endsWith("/package.json") && !changedPath.split("/").includes("node_modules")
      && !this.contentCleared.has(changedPath) && changedImpact.file.changeType !== "added";
    if (workspaceManifest) {
      const message = `Workspace package manifest changed dependencies, scripts or resolution fields: ${changedPath}; full validation required`;
      evidence.push(makeEvidence("UNKNOWN_FILE", changedPath, message));
      riskSignals.push({ level: "critical", reason: "DEPENDENCY_MANIFEST", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    // Resolved per change PATH (a rename's old path resolves independently); an unresolvable side
    // degrades to the unknown-file fallback below rather than being silently dropped.
    if (category === "test-fixture" && this.claimFixture(changedPath, graph, affectedTests, evidence)) return;
    if (category === "unknown" || category === "test-fixture") {
      // A package.json edit limited to dependency requests is covered by dependency selection, like
      // the lockfile above, so finding no reader is not a gap. Tooling that loads a file naming it
      // still is (2026-11-02).
      const specifiersOnly = (changedPath === "package.json" && this.packageJsonSpecifiersOnly) || this.specifiersOnlyManifests.has(changedPath)
        || this.exportsRemaps.get(changedPath)?.dataChanged === false;
      const options = specifiersOnly ? { allowNoReaders: true, implicitReadersUnresolvable: true } : {};
      if (this.resolveByReference(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, options)) return;
      if (covered) return;
      const message = `Unknown changed file: ${changedPath}`;
      evidence.push(makeEvidence("UNKNOWN_FILE", changedPath, message));
      riskSignals.push({ level: "critical", reason: "UNKNOWN_FILE", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    if (category === "docs") return;
    // A rename's old path is gone at HEAD like a deleted file (`X.module.css` -> `X.css`).
    const removed = changedImpact.file.changeType === "deleted" || (changedPath === changedImpact.file.oldPath && changedImpact.file.changeType === "renamed");
    if (isAssetFilePath(changedPath) && !hasNode(graph, changedPath) && !removed && !isDocumentationFile(changedPath, this.layout) && !isLockfile(changedPath)) {
      // An asset no module imports can still be read from disk by a test. It used to select nothing
      // and require nothing, which is a silent skip; it now needs reader evidence like any other
      // non-code file (2026-10-21). Assets (`.json`, `.txt`) are classified before fixture ownership is
      // tried, so a fixture no module imports is claimed here (2026-11-05: LobeHub's
      // src/spawn/__fixtures__/copilotAcp/handshake.json beside the spawn tests).
      if (this.claimFixture(changedPath, graph, affectedTests, evidence)) return;
      if (this.resolveByReference(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence)) return;
      if (covered) return;
      const message = `Unknown changed file: ${changedPath}`;
      evidence.push(makeEvidence("UNKNOWN_FILE", changedPath, message));
      riskSignals.push({ level: "critical", reason: "UNKNOWN_FILE", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    if (isAssetFilePath(changedPath)) {
      if (removed && !hasNode(graph, changedPath)) {
        if (this.resolveRemovedFile(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence)) return;
        if (covered) return;
        const message = `Deleted source/asset ${changedPath} not present in HEAD dependency graph; legacy dependents cannot be determined`;
        evidence.push(makeEvidence("DELETED_FILE_UNKNOWABLE_GRAPH", changedPath, message));
        riskSignals.push({ level: "critical", reason: "DELETED_FILE_UNKNOWABLE_GRAPH", message, paths: [changedPath] });
        if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
        return;
      }
      this.processAssetChange(changedPath, graph, profile, affectedAssets, affectedEntryPoints, affectedTests, affectedSources, evidence);
      return;
    }
    if (category === "infrastructure" && isWorkerConfig(changedPath) && this.workerConfigsOutsideSuite()) {
      if (this.resolveByReference(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence)) return;
      if (covered) return;
      const message = `Unknown changed file: ${changedPath}`;
      evidence.push(makeEvidence("UNKNOWN_FILE", changedPath, message));
      riskSignals.push({ level: "critical", reason: "UNKNOWN_FILE", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    if (category === "config" || category === "workflow" || category === "infrastructure" || category === "database") {
      evidence.push(makeEvidence("CONFIG_GLOBAL", changedPath, `Global ${category} change at ${changedPath}`));
      return;
    }
    if (infrastructureRole(changedPath) === "code" && !hasNode(graph, changedPath) && changedImpact.file.changeType !== "deleted") {
      // Code under ops/ is classified like code anywhere else only while the graph can see it. Outside
      // the graph, a test can still reach it only by naming it - one dogfood repository's tests read the Worker
      // entry point `ops/cloudflare/src/index.js` as text (2026-10-28: 7 of 42 replayed fallbacks) - so
      // its readers are resolved like any other non-code file. A deployment definition that names it
      // (wrangler.*, Dockerfile) runs it without naming anything a test would, so that stays global.
      if (this.resolveByReference(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, { implicitReadersUnresolvable: true })) return;
      if (covered) return;
      const message = `Infrastructure code ${changedPath} is outside the dependency graph; full validation required`;
      evidence.push(makeEvidence("INFRASTRUCTURE_GLOBAL", changedPath, message));
      riskSignals.push({ level: "critical", reason: "INFRASTRUCTURE_GLOBAL", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    if (category === "test") {
      this.processTestChange(changedPath, changedImpact, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, riskSignals, fallbackReasons);
      return;
    }
    if (changedImpact.file.changeType === "deleted" && !hasNode(graph, changedPath)) {
      if (this.resolveRemovedFile(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence)) return;
      if (covered) return;
      const message = `Deleted source/asset ${changedPath} not present in HEAD dependency graph; legacy dependents cannot be determined`;
      evidence.push(makeEvidence("DELETED_FILE_UNKNOWABLE_GRAPH", changedPath, message));
      riskSignals.push({ level: "critical", reason: "DELETED_FILE_UNKNOWABLE_GRAPH", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    // A Python file is also run by name: a JavaScript test or script that calls `python scripts/x.py`
    // names it without importing it. Those readers are added to what the Python graph selects (2026-11-06).
    if (changedPath.endsWith(".py") && profile.pythonSources?.includes(changedPath)) {
      this.resolveByReference(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, { allowNoReaders: true });
    }
    this.processSourceChange(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
  }

  /** Selects the tests that own `path` as a test fixture (src/repo/test-fixture-ownership.ts), if any do. */
  private claimFixture(path: string, graph: DependencyGraph, affectedTests: Map<string, TestImpact>, evidence: ImpactEvidence[]): boolean {
    const ownership = resolveTestFixtureOwners(path, this.isTestFile, this.repositoryFiles);
    if (!ownership) return false;
    for (const owner of ownership.owners) this.addAffectedTest(path, owner, graph, affectedTests, "TEST_FIXTURE_OWNER", evidence);
    evidence.push(makeEvidence("TEST_FIXTURE_OWNER", path, `Test fixture ${path} under ${ownership.fixtureDir} is owned by ${ownership.owners.length} test(s) in ${ownership.testsDir} (${ownership.scope})`));
    return true;
  }

  /**
   * A file gone at HEAD that the HEAD graph has no node for (2026-11-04). Its old importers cannot be
   * listed, but each one is either changed in this delta (its import was edited or removed, so it is
   * analysed as a changed file), still imports the missing path (an unresolved import), or now resolves
   * the same specifier to a sibling (`./x` from a deleted `x.ts` to a surviving `x/index.ts`). The last
   * two are found here; anything else observes the absence only by naming the file, which the reference
   * resolver checks without its directories. A directory listing is not modelled, as for an added asset
   * the graph does import, nor is a tsconfig `paths` fallback that now resolves to another directory. Previously every such file fell back: the LobeHub catch replay's StyleX
   * migration renames `X.module.css` to `X.css` and 16 of 47 verify commits ran the full suite for it.
   */
  private resolveRemovedFile(
    removedPath: string,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): boolean {
    if (this.repositoryFiles?.has(removedPath)) return false;
    const key = moduleKey(removedPath);
    const names = new Set([posix.basename(removedPath), posix.basename(removedPath.replace(/\.[^./]+$/, "")), posix.basename(key)]);
    // Conservative: any unresolved import whose last segment could name the file blocks, wherever it is.
    const importer = this.unresolved.find((ref) => !ref.computed && names.has(posix.basename(ref.specifier.split(/[?#]/)[0]!)));
    if (importer) {
      const blocker = `${importer.importer} imports ${importer.specifier}, which may have resolved to the removed ${removedPath}`;
      evidence.push(makeEvidence("UNKNOWN_FILE", removedPath, blocker));
      this.referenceBlockers.set(removedPath, [blocker]);
      return false;
    }
    if (!this.resolveByReference(removedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, { implicitReadersUnresolvable: true, removed: true })) return false;
    for (const node of graph.nodes) {
      if (node.path === removedPath || moduleKey(node.path) !== key) continue;
      evidence.push(makeEvidence("DELETED_FILE_LEGACY_DEPENDENTS", removedPath, `${node.path} may now resolve imports of the removed ${removedPath}`, node.path));
      this.processSourceChange(node.path, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
    }
    evidence.push(makeEvidence("DELETED_FILE_LEGACY_DEPENDENTS", removedPath, `No HEAD import can still reach the removed ${removedPath}; its former importers are changed files`));
    return true;
  }

  /** Projects some test compiles (src/repo/compiled-projects.ts), computed once per analysis and only
   * when file contents are available. */
  private compiledProjectsFor(graph: DependencyGraph): CompiledProject[] {
    if (this.compiledProjectCache) return this.compiledProjectCache;
    this.compiledProjectCache = !this.repositoryFiles || !this.readRepositoryFile ? [] : compiledProjects({
      files: this.sortedRepositoryFiles,
      read: this.readRepositoryFile,
      isTestFile: this.isTestFile,
      dependenciesOf: (path) => (hasNode(graph, path) ? graph.transitiveDependenciesOf(path) : []),
    });
    return this.compiledProjectCache;
  }

  /** The files the repository's test script runs, when that can be modelled completely. Only plain
   * JavaScript/TypeScript profiles are modelled: workspaces, Vue scopes and Go/Maven adapters own
   * their own universes. */
  private fullSuiteUniverse(profile: RepositoryProfile, graph: DependencyGraph): ScriptUniverse | undefined {
    if (!this.repositoryFiles || !this.readRepositoryFile) return undefined;
    const owned = (record: Record<string, string> | undefined) => Object.keys(record ?? {}).length > 0;
    if (profile.workspaceTestPackages?.length || profile.vueScope || owned(profile.goTestPackages) || owned(profile.mavenTestModules)) return undefined;
    if (typeof profile.packageJson.scripts.test !== "string") return undefined;
    const files = this.repositoryFiles;
    return modelTestScriptUniverse({
      scripts: profile.packageJson.scripts,
      discoveredTests: profile.testFilePaths,
      dependenciesOf: (path) => (hasNode(graph, path) ? graph.transitiveDependenciesOf(path) : []),
      read: this.readRepositoryFile,
      exists: (path) => files.has(path) || [...files].some((file) => file.startsWith(`${path.replace(/\/$/, "")}/`)),
    });
  }

  /**
   * Narrows an otherwise-unknown changed file to the tests that read it, when every reader resolves
   * (src/repo/file-references.ts). Returns false, leaving the caller's full-validation fallback in
   * place, when the inputs are unavailable, the file is loaded implicitly by tooling, or any reader
   * cannot be resolved.
   */
  private resolveByReference(
    changedPath: string,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
    { implicitReadersUnresolvable = false, allowNoReaders = false, removed = false }: { implicitReadersUnresolvable?: boolean; allowNoReaders?: boolean; removed?: boolean } = {},
  ): boolean {
    if (!this.repositoryFiles || !this.readRepositoryFile) return false;
    if (isImplicitlyLoadedFile(changedPath) && !(isWorkerConfig(changedPath) && this.workerConfigsOutsideSuite())) return false;
    const layout = this.layout;
    const scripts = profile.packageJson.scripts;
    const resolution = resolveFileReferences(changedPath, {
      files: this.sortedRepositoryFiles,
      read: this.readRepositoryFile,
      isTestFile: this.isTestFile,
      isDocumentation: (path) => layout.isDocumentationPath(path) || isAgentConfigurationPath(path),
      inGraph: (path) => hasNode(graph, path),
      isCodeFile: isSourceFilePath,
      workflowFeedsTests: (content, names) => workflowFeedsTests(content, names, scripts),
      contentCleared: this.contentCleared,
      implicitReadersUnresolvable,
      allowNoReaders,
      removed,
      testPhases: this.selectTestPhases,
      workerConfigsOutsideSuite: this.workerConfigsOutsideSuite(),
    });
    if (resolution.unresolvable.length > 0) {
      const blockers = resolution.blockers.map(({ reason, chain }) => chain.length > 1 ? `${reason} (via ${chain.slice(1).join(" <- ")})` : reason);
      this.referenceBlockers.set(changedPath, blockers);
      evidence.push(makeEvidence("UNKNOWN_FILE", changedPath, `References to ${changedPath} could not be resolved: ${blockers.slice(0, 5).join("; ")}${blockers.length > 5 ? `; and ${blockers.length - 5} more` : ""}`));
      return false;
    }
    for (const reader of resolution.readers) {
      if (reader.kind !== "test" && reader.kind !== "graph-code") continue;
      evidence.push(makeEvidence("FILE_REFERENCE", changedPath, `${reader.path} names ${reader.via}`, reader.path));
    }
    for (const test of resolution.tests) this.addAffectedTest(changedPath, test, graph, affectedTests, "FILE_REFERENCE", evidence);
    for (const phase of resolution.phases) {
      this.testPhases.add(phase);
      evidence.push(makeEvidence("FILE_REFERENCE", changedPath, `the test script runs \`${phase}\`, which reads ${changedPath}`));
    }
    for (const code of resolution.code) {
      if (!affectedSources.has(code)) affectedSources.set(code, []);
      affectedSources.get(code)!.push(makeEvidence("FILE_REFERENCE", changedPath, `${code} reads ${changedPath}`, code));
      const codeDependents = graph.transitiveDependentsOf(code);
      const testDependents = this.testDependents(graph, code, codeDependents);
      for (const dependent of codeDependents) {
        if (this.isTestFile(dependent) && testDependents.has(dependent)) this.addAffectedTest(changedPath, dependent, graph, affectedTests, "FILE_REFERENCE", evidence);
        else if (nodeByPath(graph, dependent)?.isEntryPoint) this.addAffectedEntryPoint(dependent, profile, affectedEntryPoints, "FILE_REFERENCE", changedPath, evidence);
      }
      for (const scriptPath of collectScriptsAmong([code, ...codeDependents], this.isTestFile, this.layout)) {
        if (!affectedScripts.has(scriptPath)) affectedScripts.set(scriptPath, []);
        affectedScripts.get(scriptPath)!.push(makeEvidence("FILE_REFERENCE", changedPath, `${changedPath} is read by script ${scriptPath}`, scriptPath));
      }
    }
    return true;
  }

  private processAssetChange(
    assetPath: string,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedAssets: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedSources: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): void {
    if (!affectedAssets.has(assetPath)) affectedAssets.set(assetPath, []);
    affectedAssets.get(assetPath)!.push(makeEvidence("ASSET_DEPENDENCY", assetPath, `Changed asset: ${assetPath}`));
    if (!hasNode(graph, assetPath)) return;
    const dependents = graph.transitiveDependentsOf(assetPath);
    const testDependents = this.testDependents(graph, assetPath, dependents);
    for (const dependent of dependents) {
      if (nodeByPath(graph, dependent)?.isEntryPoint) {
        this.addAffectedEntryPoint(dependent, profile, affectedEntryPoints, "ASSET_DEPENDENCY", assetPath, evidence);
      }
      if (this.isTestFile(dependent) && testDependents.has(dependent)) {
        this.addAffectedTest(assetPath, dependent, graph, affectedTests, "ASSET_DEPENDENCY", evidence);
      }
      if (isSourceFilePath(dependent) && !this.isTestFile(dependent)) {
        if (!affectedSources.has(dependent)) affectedSources.set(dependent, []);
        affectedSources.get(dependent)!.push(makeEvidence("ASSET_DEPENDENCY", assetPath, `Asset ${assetPath} affects source ${dependent}`, dependent));
      }
    }
  }

  private processSourceChange(
    sourcePath: string,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): void {
    for (const project of this.compiledProjectsFor(graph)) {
      if (!project.files.has(sourcePath)) continue;
      for (const test of project.tests) {
        this.addAffectedTest(sourcePath, test, graph, affectedTests, "COMPILED_PROJECT", evidence);
        evidence.push(makeEvidence("COMPILED_PROJECT", sourcePath, `${test} compiles ${project.config}, which includes ${sourcePath}`, test));
      }
    }
    if (!hasNode(graph, sourcePath)) {
      if (isPotentialNextEntryPoint(sourcePath, this.layout) || isScriptFile(sourcePath, this.layout)) {
        this.addAffectedEntryPoint(sourcePath, profile, affectedEntryPoints, "NEW_ENTRY_POINT", sourcePath, evidence);
      }
      return;
    }

    if (!this.isTestFile(sourcePath)) {
      if (!affectedSources.has(sourcePath)) affectedSources.set(sourcePath, []);
      affectedSources.get(sourcePath)!.push(makeEvidence("DIRECT_CHANGE", sourcePath, `Changed source: ${sourcePath}`));
    }
    if (isEntryPoint(profile, sourcePath) || classifyNextEntryPoint(sourcePath, this.layout)) {
      this.addAffectedEntryPoint(sourcePath, profile, affectedEntryPoints, "NEXT_ENTRY_POINT", sourcePath, evidence);
    }

    const dependents = graph.transitiveDependentsOf(sourcePath);
    const testDependents = this.exportLevelTests(sourcePath, this.testDependents(graph, sourcePath, dependents), evidence);
    for (const dependent of dependents) {
      if (!this.isTestFile(dependent)) {
        if (!affectedSources.has(dependent)) affectedSources.set(dependent, []);
        affectedSources.get(dependent)!.push(makeEvidence("DEPENDENCY", sourcePath, `${sourcePath} affects ${dependent} via dependency graph`, dependent));
      }
      if (nodeByPath(graph, dependent)?.isEntryPoint) {
        this.addAffectedEntryPoint(dependent, profile, affectedEntryPoints, "DEPENDENCY", sourcePath, evidence);
      }
      if (this.isTestFile(dependent) && testDependents.has(dependent)) {
        this.addAffectedTest(sourcePath, dependent, graph, affectedTests, "DEPENDENCY", evidence);
      }
    }

    const reachable = new Set([sourcePath, ...dependents]);
    for (const scriptPath of collectScriptsAmong(reachable, this.isTestFile, this.layout)) {
      if (!affectedScripts.has(scriptPath)) affectedScripts.set(scriptPath, []);
      affectedScripts.get(scriptPath)!.push(makeEvidence("DEPENDENCY", sourcePath, `${sourcePath} affects script ${scriptPath}`, scriptPath));
    }
  }

  /**
   * Handles a directly-changed test file (2026-08-24 fix). Previously changed tests fell through to
   * processSourceChange, which never added the test itself to affectedTests, so a "test-only" diff
   * (e.g. Nx #36723) authorized SAFE_TO_PROPOSE with zero selected tests. Now:
   *   - deleted test: never select the (nonexistent) path; fall back when its node is absent, else
   *     traverse its legacy dependents conservatively;
   *   - rename/copy source identity (oldPath): record the legacy identity only — the destination is the
   *     executable test and is handled on its own path iteration;
   *   - added / modified / renamed-destination / copied-destination: select the test itself and then
   *     traverse dependents (shared test helpers) exactly like processSourceChange.
   */
  private processTestChange(
    changedPath: string,
    changedImpact: ChangedImpact,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
    riskSignals: ImpactRiskSignal[],
    fallbackReasons: string[],
  ): void {
    const file = changedImpact.file;
    const isOldPath = file.oldPath !== undefined && changedPath === file.oldPath;

    if (file.changeType === "deleted") {
      // Never select a deleted test. If its node is still present (stale/base graph), traverse legacy
      // dependents conservatively; otherwise safety cannot be established and we require full validation.
      if (hasNode(graph, changedPath)) {
        this.processSourceChange(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
        return;
      }
      const message = `Deleted test ${changedPath}; legacy coverage/dependents cannot be established safely`;
      evidence.push(makeEvidence("DELETED_FILE_UNKNOWABLE_GRAPH", changedPath, message));
      riskSignals.push({ level: "critical", reason: "DELETED_FILE_UNKNOWABLE_GRAPH", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }

    if (isOldPath) {
      evidence.push(makeEvidence("RENAMED_FILE_LEGACY_IDENTITY", changedPath, `Renamed test source ${changedPath}; destination handled separately`));
      return;
    }

    if (this.isTestFile(changedPath)) {
      this.addAffectedTest(changedPath, changedPath, graph, affectedTests, "DIRECT_TEST_CHANGE", evidence);
    }
    this.processSourceChange(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
  }

  private addAffectedEntryPoint(
    path: string,
    profile: RepositoryProfile,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    reason: ImpactReason,
    changedFile: string,
    evidence: ImpactEvidence[],
  ): void {
    const ep = isEntryPoint(profile, path);
    const kind = ep?.kind ?? classifyNextEntryPoint(path, this.layout) ?? "unknown";
    const existing = affectedEntryPoints.get(path);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      affectedEntryPoints.set(path, { path, kind, reasons: [reason] });
    }
    evidence.push(makeEvidence(reason, changedFile, `Affected entry point ${path} (${kind})`, path));
  }

  private addAffectedTest(
    changedFile: string,
    testPath: string,
    graph: DependencyGraph,
    affectedTests: Map<string, TestImpact>,
    reason: ImpactReason,
    evidence: ImpactEvidence[],
  ): void {
    let existing = affectedTests.get(testPath);
    if (!existing) {
      existing = { path: testPath, reasons: [], evidence: [] };
      affectedTests.set(testPath, existing);
    }
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    const path = shortestDependentPathToTest(graph, changedFile, testPath);
    const ev = makeEvidence(reason, changedFile, `Affected test: ${testPath} due to ${reason}`, testPath, path);
    existing.evidence.push(ev);
    evidence.push(ev);
  }


  private handleStructuralNextLayout(
    changedImpacts: ChangedImpact[],
    profile: RepositoryProfile,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedSources: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): void {
    for (const changedImpact of changedImpacts) {
      if (changedImpact.category !== "entry-point") continue;
      for (const path of allChangePaths(changedImpact.file)) {
        if (!isNextLayoutEntry(this.layout, path)) continue;
        const descendants = collectDescendantEntryPoints(profile, this.layout, path);
        for (const desc of descendants) {
          this.addAffectedEntryPoint(desc.path, profile, affectedEntryPoints, "NEXT_LAYOUT_ANCESTOR", path, evidence);
          if (!affectedSources.has(desc.path)) affectedSources.set(desc.path, []);
          affectedSources.get(desc.path)!.push(makeEvidence("NEXT_LAYOUT_ANCESTOR", path, `Layout ancestor ${path} structurally affects ${desc.path}`, desc.path));
        }
      }
    }
  }

  private handleAddedEntryPoints(
    delta: GitDelta,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedTests: Map<string, TestImpact>,
    evidence: ImpactEvidence[],
    _fallbackReasons: string[],
  ): void {
    for (const added of this.detectAddedEntryPoints(delta)) {
      if (!affectedEntryPoints.has(added.path)) {
        affectedEntryPoints.set(added.path, { path: added.path, kind: added.kind, reasons: ["NEW_ENTRY_POINT"] });
        evidence.push(makeEvidence("NEW_ENTRY_POINT", added.path, `New entry point: ${added.path} (${added.kind})`, added.path));
      }
      if (added.kind === "test" && !affectedTests.has(added.path)) {
        affectedTests.set(added.path, { path: added.path, reasons: ["NEW_TEST_FILE"], evidence: [makeEvidence("NEW_TEST_FILE", added.path, `New test file: ${added.path}`, added.path)] });
      }
      if (added.kind === "script") {
        if (!affectedSources.has(added.path)) affectedSources.set(added.path, []);
        affectedSources.get(added.path)!.push(makeEvidence("NEW_SCRIPT_FILE", added.path, `New script: ${added.path}`, added.path));
      }
    }
  }

  private detectAddedEntryPoints(delta: GitDelta): Array<{ path: string; kind: NonNullable<EntryPoint["kind"] | "script" | "test"> }> {
    const result: Array<{ path: string; kind: NonNullable<EntryPoint["kind"] | "script" | "test"> }> = [];
    for (const file of delta.files) {
      if (file.changeType !== "added") continue;
      const kind = classifyNextEntryPoint(file.path, this.layout);
      if (kind) result.push({ path: file.path, kind });
      else if (isScriptFile(file.path, this.layout)) result.push({ path: file.path, kind: "script" });
      else if (this.isTestFile(file.path)) result.push({ path: file.path, kind: "test" });
    }
    return result;
  }

  /**
   * A computed `import(name)` or `require(path)` can load any file, so no graph edge says which changed
   * file it reaches. It can only change what a test observes if that test runs the importer, so every
   * test that does - the importer itself when it is a test, and each test depending on it - is
   * selected whenever anything other than documentation changed. An importer outside the dependency
   * graph has no known runners and requires full validation (2026-10-22, narrowing PR #32's global
   * block: one repository's four computed imports had turned every analysis into a full run).
   */
  private collectComputedImportTests(
    graphResult: DependencyGraphResult,
    graph: DependencyGraph,
    changedImpacts: ChangedImpact[],
    affectedTests: Map<string, TestImpact>,
    evidence: ImpactEvidence[],
    riskSignals: ImpactRiskSignal[],
    fallbackReasons: string[],
  ): void {
    const importers = [...new Set(graphResult.unresolved.filter((ref) => ref.computed).map((ref) => ref.importer))].sort();
    if (importers.length === 0 || !changedImpacts.some((impact) => impact.category !== "docs")) return;
    for (const importer of importers) {
      if (!hasNode(graph, importer)) {
        const message = `Computed module load in ${importer} is outside the dependency graph; full validation required`;
        evidence.push(makeEvidence("COMPUTED_IMPORT", importer, message));
        riskSignals.push({ level: "critical", reason: "COMPUTED_IMPORT", message, paths: [importer] });
        if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
        continue;
      }
      const importerDependents = graph.transitiveDependentsOf(importer);
      const testDependents = this.testDependents(graph, importer, importerDependents);
      const runners = [importer, ...importerDependents.filter((path) => testDependents.has(path))].filter((path) => this.isTestFile(path));
      for (const test of runners) this.addAffectedTest(importer, test, graph, affectedTests, "COMPUTED_IMPORT", evidence);
      evidence.push(makeEvidence("COMPUTED_IMPORT", importer, `${importer} loads a computed module specifier; the ${runners.length} test(s) that run it are selected`));
    }
  }

  /** Playwright specs that visit an affected Next.js route (route-visits.ts, 2026-11-06). Without the
   * repository's contents no spec can be read, which leaves selection as the graph made it. */
  private collectRouteVisitTests(
    profile: RepositoryProfile,
    graph: DependencyGraph,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    evidence: ImpactEvidence[],
  ): void {
    const read = this.readRepositoryFile;
    if (!read) return;
    const entries = [...affectedEntryPoints.values()].filter((entry) => entry.kind.startsWith("next-"));
    if (entries.length === 0) return;
    const specs = this.knownTestPaths(profile, graph).flatMap((path) => {
      const source = read(path);
      return source !== undefined && isPlaywrightSpec(source) ? [{ path, visits: visitedRoutes(source) }] : [];
    });
    if (specs.length === 0) return;
    for (const entry of entries) {
      const route = nextAppRoute(entry.path, entry.kind);
      for (const spec of specs) {
        const visited = route ? spec.visits.paths.find((path) => routeMatches(route, path)) : undefined;
        const why = !route ? `${entry.path} has no route DiffCI can derive, so every end-to-end spec may reach it`
          : visited ? `${spec.path} visits ${visited}, served by ${entry.path}`
          : spec.visits.computed ? `${spec.path} visits a URL built at run time, which may be served by ${entry.path}`
          : undefined;
        if (!why) continue;
        this.addAffectedTest(entry.path, spec.path, graph, affectedTests, "ROUTE_VISIT", evidence);
        evidence.push(makeEvidence("ROUTE_VISIT", entry.path, why, spec.path));
      }
    }
  }

  private collectAlwaysRunTests(
    profile: RepositoryProfile,
    graph: DependencyGraph,
    affectedTests: Map<string, TestImpact>,
    evidence: ImpactEvidence[],
    graphRuntimeTests: readonly string[],
  ): void {
    const alwaysRunPaths = new Set<string>([...(profile.vueTypeTestPaths ?? []), ...(profile.vueRuntimeAlwaysRunPaths ?? []), ...graphRuntimeTests]);
    for (const check of [...this.alwaysRunChecks, ...alwaysRunChecksFromProfile(profile)]) {
      for (const path of this.knownTestPaths(profile, graph)) {
        if (check.patterns.some((pattern) => pattern.test(path))) { alwaysRunPaths.add(path); continue; }
        if (check.globs?.some((glob) => matchesTestGlob(path, glob))) alwaysRunPaths.add(path);
      }
    }
    for (const testPath of alwaysRunPaths) {
      if (!affectedTests.has(testPath)) affectedTests.set(testPath, { path: testPath, reasons: ["ALWAYS_RUN_POLICY"], evidence: [] });
      const existing = affectedTests.get(testPath)!;
      if (!existing.reasons.includes("ALWAYS_RUN_POLICY")) existing.reasons.push("ALWAYS_RUN_POLICY");
      const ev = makeEvidence("ALWAYS_RUN_POLICY", testPath, `Always-run check policy includes ${testPath}`, testPath);
      existing.evidence.push(ev);
      evidence.push(ev);
    }
  }
}

/*
 * The local `matchesGlob` that stood here was DELETED on 2026-08-30.
 *
 * It was the copy Phase 01 intended to remove when `test-discovery.ts` became the single definition of
 * "does this path match this glob", and it carried two defects the shared one does not:
 *
 *   PERFORMANCE. It translated `**\/?(*.)+(spec|test).[jt]s?(x)` into
 *   `^.([^/]*.)+(spec|test).[jt]s.(x)$` - a nested quantifier over an overlapping inner pattern, which
 *   backtracks catastrophically. Measured on one non-matching path: 0.69 ms at 10 characters, 106 ms at
 *   20, 1.8 s at 24, 30 s at 28, roughly 4x per additional character. Prettier's paths are 30-60
 *   characters, so `prettier/prettier` spent 601 seconds per candidate against a full suite that runs in
 *   214, and a single instrumented candidate was still inside this function after 84 minutes with 100%
 *   of CPU samples in it.
 *
 *   CORRECTNESS. It stripped the leading `**\/` and then anchored with `^`, so
 *   `**\/__tests__\/**\/*.[jt]s?(x)` became `^__tests__\/...$` and matched NEITHER
 *   `src/__tests__/foo.test.js` NOR `__tests__/foo.test.js`.
 *
 * Both came from hand-translating glob syntax into regex by string substitution. There is now one
 * implementation, in test-discovery.ts, imported above as `matchesTestGlob`.
 */
