import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type {
  EntryPoint,
  PackageManager,
  PathAlias,
  RepositoryProfile,
  SourceRoot,
  TestLocation,
  Workflow,
} from "./types.js";

import { createTestFileMatcher, discoverTestRunnerConfigs, matchesGlob, type TestFileMatcherOptions } from "./test-discovery.js";
import { compileIgnoreRegexes, isIgnoredPath, isUnderRoots } from "./runner-universe.js";
import { defaultExcludesFor, defaultIncludesFor, detectDeclaredFrameworks } from "./test-framework.js";
import { readRepositoryConfig } from "./repo-config.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "tmp",
  "temp",
]);

export interface AnalyzeRepositoryOptions {
  repoPath?: string;
  sourceRoots?: string[];
  testPatterns?: string[];
  excludeDirs?: string[];
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function repoRelative(repoPath: string, absolutePath: string): string {
  return toPosix(relative(repoPath, absolutePath));
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function detectPackageManager(repoPath: string): PackageManager {
  if (existsSync(join(repoPath, "bun.lockb")) || existsSync(join(repoPath, "bun.lock"))) {
    return "bun";
  }
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(repoPath, "package-lock.json"))) {
    return "npm";
  }
  return "unknown";
}

function findConfig(repoPath: string, name: string): string | undefined {
  const candidates = readdirSync(repoPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(name))
    .map((entry) => entry.name)
    .sort();
  return candidates.length > 0 ? candidates[0] : undefined;
}

function discoverWorkflows(repoPath: string): Workflow[] {
  const workflowDir = join(repoPath, ".github", "workflows");
  if (!existsSync(workflowDir)) return [];

  const workflows: Workflow[] = [];
  for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ya?ml)$/.test(entry.name)) continue;
    const path = repoRelative(repoPath, join(workflowDir, entry.name));
    workflows.push({ path });
  }
  return workflows;
}

function parseTsconfigPaths(paths: Record<string, string[]> | undefined): PathAlias[] {
  if (!paths) return [];
  return Object.entries(paths).map(([pattern, substitutions]) => ({
    pattern,
    substitutions: substitutions.map(toPosix),
  }));
}

function loadTsconfig(repoPath: string): RepositoryProfile["tsconfig"] | undefined {
  const path = join(repoPath, "tsconfig.json");
  if (!existsSync(path)) return undefined;

  const raw = readJson<Record<string, unknown>>(path);
  if (!raw) return undefined;

  const compilerOptions = (raw.compilerOptions ?? {}) as Record<string, unknown>;
  return {
    path: toPosix(relative(repoPath, path)),
    baseUrl: typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : undefined,
    pathAliases: parseTsconfigPaths(
      (compilerOptions.paths ?? {}) as Record<string, string[]>,
    ),
    allowJs: compilerOptions.allowJs === true,
    include: Array.isArray(raw.include) ? raw.include.map(String) : [],
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [],
  };
}

function inferRootKind(name: string): SourceRoot["kind"] {
  if (name === "src" || name === "lib") return "source";
  if (name === "app" || name === "pages") return "app";
  if (name === "scripts" || name === "tools" || name === "bin") return "scripts";
  if (name === "ops") return "operations";
  if (name === "tests" || name === "test") return "tests";
  if (name === "api") return "api";
  return "source";
}

function listDirectSubdirectories(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function discoverSourceRoots(
  repoPath: string,
  sourceRoots?: string[],
  excludeDirs?: string[],
): SourceRoot[] {
  const roots: SourceRoot[] = [];
  const exclusions = new Set(excludeDirs ?? []);

  function tryRoot(name: string, kind: SourceRoot["kind"]): void {
    if (exclusions.has(name)) return;
    const full = join(repoPath, name);
    if (existsSync(full) && statSync(full).isDirectory()) {
      roots.push({ path: name, kind });
    }
  }

  if (sourceRoots && sourceRoots.length > 0) {
    for (const name of sourceRoots) {
      tryRoot(name, inferRootKind(name));
    }
    return roots;
  }

  tryRoot("src", "source");
  tryRoot("app", "app");
  tryRoot("pages", "app");
  tryRoot("lib", "source");
  tryRoot("scripts", "scripts");
  // Phase 01 follow-up (2026-08-26): "scripts" is not the only conventional name for build and
  // release tooling. Recognising tools/ and bin/ is what lets impact classification derive "is this
  // auxiliary code?" from the repository instead of assuming DiffCI's own two directory names.
  tryRoot("tools", "scripts");
  tryRoot("bin", "scripts");
  tryRoot("ops", "operations");
  tryRoot("tests", "tests");
  tryRoot("test", "tests");
  tryRoot("api", "api");

  // Real finding, Stage 0 medium batch (2026-08-21): colinhacks/zod (and other monorepos - trpc,
  // vitest before it was excluded on the separate tsconfig gap) have a top-level scripts/ directory
  // (an AUXILIARY root - build/release tooling, not application code) but no src/app/lib/tests/test/api
  // at the root; their real source and tests live nested under packages/<name>/src/. The old
  // `roots.length === 0` fallback condition meant scripts/ alone being present was enough to skip the
  // "scan every top-level directory" fallback entirely, so packages/ - where everything actually is -
  // was never scanned at all: discoverTests() came back with testsTotal:0 for every single delta in
  // these repositories, and downstream selected-test counts (computed independently via the impact
  // graph, not this file list) were then compared against a total of 0, producing the impossible
  // "selected > total" records caught in Gate C's aggregation. Fixed by only skipping the fallback when
  // a PRIMARY (code-bearing) root was found - scripts/ops alone no longer suppresses it.
  //
  // Phase 01 (2026-08-26) extends the same reasoning to `tests`: a top-level test/ or tests/ directory
  // is no more evidence that a repository's CODE lives at the root than a scripts/ directory is.
  // facebook/docusaurus has exactly that shape - a root test/ with all real code under packages/ - and
  // the fallback stayed suppressed, so packages/ was never scanned at all.
  const hasPrimarySourceRoot = roots.some(
    (r) => r.kind !== "scripts" && r.kind !== "operations" && r.kind !== "tests",
  );
  if (!hasPrimarySourceRoot) {
    const covered = new Set(roots.map((r) => r.path));
    const dirs = listDirectSubdirectories(repoPath)
      .filter((name) => !IGNORED_DIRS.has(name) && !exclusions.has(name) && !covered.has(name));
    for (const name of dirs) {
      roots.push({ path: name, kind: "source" });
    }
  }

  return roots;
}

/**
 * Matches a repo-relative (posix) path against a glob pattern. Delegates to the shared matcher in
 * test-discovery.ts (Phase 01, 2026-08-26) - this file previously carried its own near-identical
 * copy, so "is this a test?" had two answers that could and did drift. The shared one additionally
 * understands the extended-glob syntax that vitest's and jest's own default include globs use.
 */
function matchesTestGlob(path: string, pattern: string): boolean {
  return matchesGlob(path, pattern);
}

function scanFiles(
  dirPath: string,
  repoPath: string,
  excludeDirs: ReadonlySet<string>,
  callback: (relativePath: string, fileName: string) => void,
): void {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name) || entry.name.startsWith(".")) continue;
      scanFiles(join(dirPath, entry.name), repoPath, excludeDirs, callback);
      continue;
    }
    if (!entry.isFile()) continue;
    callback(repoRelative(repoPath, join(dirPath, entry.name)), entry.name);
  }
}

/**
 * Scans the WHOLE repository for test files, not only the discovered source roots (Phase 01,
 * 2026-08-26).
 *
 * Source roots are a guess at where a repository keeps its code, assembled from a fixed list of
 * top-level directory names. Where a repository keeps its TESTS is exactly the thing that must not
 * be guessed. Measured cost of the previous behaviour: `facebook/docusaurus` has 241 test files and
 * DiffCI discovered 2 - the two in the root `__tests__/`. Its top-level `test/` directory counted as
 * a "primary" source root, which suppressed the fallback that would have scanned `packages/`, where
 * the other 239 live. Selecting from a test universe that is 1% of the real one is not a coverage
 * gap, it is a selection built on a false denominator.
 *
 * The exclusion set (node_modules, build output, VCS internals, dotfiles) still applies, so this is
 * bounded by the repository's own committed tree.
 */
function discoverTests(
  repoPath: string,
  patterns: string[],
  excludeDirs: string[],
  matcherOptions: TestFileMatcherOptions = {},
): { locations: TestLocation[]; filePaths: string[] } {
  const counts = new Map<string, number>();
  const filePaths: string[] = [];
  const exclusions = new Set([...IGNORED_DIRS.values(), ...excludeDirs]);
  const isTest = createTestFileMatcher(patterns, matcherOptions);

  if (existsSync(repoPath)) {
    scanFiles(repoPath, repoPath, exclusions, (relPath) => {
      if (!isTest(relPath)) return;
      // Attribute the file to the first pattern that explains it, for the `tests` glob summary.
      const pattern = patterns.find((p) => matchesTestGlob(relPath, p)) ?? patterns[0];
      if (pattern !== undefined) counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
      filePaths.push(relPath);
    });
  }

  const locations = Array.from(counts.entries())
    .map(([glob, count]) => ({ glob, count }))
    .sort((a, b) => a.glob.localeCompare(b.glob));
  return { locations, filePaths: filePaths.sort() };
}

function discoverConfigFiles(repoPath: string, excludeDirs: string[]): string[] {
  const configNames = new Set<string>([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "tsconfig.json",
    "jsconfig.json",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "postcss.config.mjs",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
    "biome.json",
    ".eslintrc.json",
    ".prettierrc",
    "playwright.config.ts",
    "vitest.config.ts",
    "jest.config.js",
    "next-env.d.ts",
    ".gitignore",
    ".env.example",
    ".env.local.example",
  ]);

  const found: string[] = [];
  const exclusions = new Set([...IGNORED_DIRS.values(), ...excludeDirs]);

  function walk(dirPath: string): void {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (exclusions.has(entry.name) || entry.name.startsWith(".")) continue;
        if (entry.name === "ops" || entry.name === "scripts") {
          found.push(repoRelative(repoPath, full));
        }
        walk(full);
        continue;
      }
      if (configNames.has(entry.name)) {
        found.push(repoRelative(repoPath, full));
      }
    }
  }

  walk(repoPath);
  return found.sort();
}

function isSourceExt(ext: string): boolean {
  const sourceExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
  return sourceExts.has(ext.toLowerCase());
}

function classifyEntryPoints(
  repoPath: string,
  isNext: boolean,
  roots: SourceRoot[],
  excludeDirs: string[],
): EntryPoint[] {
  const entries: EntryPoint[] = [];
  const exclusions = new Set([...IGNORED_DIRS.values(), ...excludeDirs]);

  function walk(dirPath: string, fromRoot: string): void {
    const entriesList = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entriesList) {
      const full = join(dirPath, entry.name);
      const rel = repoRelative(repoPath, full);
      if (entry.isDirectory()) {
        if (exclusions.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full, fromRoot);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (!isSourceExt(ext)) continue;
      const name = basename(entry.name, ext);
      const lower = name.toLowerCase();

      if (isNext && rel.startsWith(fromRoot + "/")) {
        if (lower === "page") {
          entries.push({ path: rel, kind: "next-page" });
        } else if (lower === "layout") {
          entries.push({ path: rel, kind: "next-layout" });
        } else if (lower === "route") {
          entries.push({ path: rel, kind: "next-route" });
        } else if (lower === "api") {
          entries.push({ path: rel, kind: "next-api" });
        } else if (lower === "loading") {
          entries.push({ path: rel, kind: "next-loading" });
        } else if (lower === "error") {
          entries.push({ path: rel, kind: "next-error" });
        } else if (lower === "template") {
          entries.push({ path: rel, kind: "next-template" });
        }
      }

      if (lower.includes(".test") || lower.includes(".spec")) {
        entries.push({ path: rel, kind: "test" });
      }

      if (fromRoot === "scripts") {
        entries.push({ path: rel, kind: "script" });
      }
    }
  }

  for (const root of roots) {
    const fullRoot = join(repoPath, root.path);
    if (!existsSync(fullRoot)) continue;
    walk(fullRoot, root.path);
  }

  return entries;
}

export function analyzeRepository(
  options: AnalyzeRepositoryOptions = {},
): RepositoryProfile {
  const repoPath = options.repoPath ? resolve(options.repoPath) : process.cwd();
  const excludeDirs = options.excludeDirs ?? [];
  const packageManager = detectPackageManager(repoPath);
  const packageJsonRaw = readJson<{
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(repoPath, "package.json"));

  const dependencies = Object.keys(packageJsonRaw?.dependencies ?? {});
  const devDependencies = Object.keys(packageJsonRaw?.devDependencies ?? {});
  const scripts = packageJsonRaw?.scripts ?? {};
  const isNext = dependencies.includes("next") || devDependencies.includes("next");

  const tsconfig = loadTsconfig(repoPath);
  const roots = discoverSourceRoots(repoPath, options.sourceRoots, excludeDirs);
  // Test universe = DiffCI's conventional defaults, PLUS the default include globs of every test
  // framework the repository declares, PLUS what its own root Vitest/Jest configs declare explicitly
  // (static read, never executed). The middle term is Phase 01's addition: a repository that relies
  // on its runner's defaults - immer, execa - previously contributed nothing at all.
  const testDiscovery = discoverTestRunnerConfigs(repoPath, scripts);
  const declaredFrameworks = detectDeclaredFrameworks(packageJsonRaw);
  const diffciConfig = readRepositoryConfig(repoPath, packageJsonRaw as Record<string, unknown> | undefined);
  // `testDiscovery.patterns` is authoritative: DiffCI's conventional globs plus whatever the
  // repository declared explicitly. A framework's own defaults are added on top, and are the only
  // patterns its default excludes are allowed to veto.
  const authoritativePatterns = options.testPatterns ?? testDiscovery.patterns;
  // DEFECT 17. When discovery replaced the defaults, the repository has told us exactly which files
  // its runner executes - and adding the framework DEFAULT includes back on top here would re-widen
  // the universe that was just narrowed, making the whole fix a no-op. That is precisely how
  // ts-jest reported 40 executable tests when jest runs 20.
  const testPatterns =
    options.testPatterns ??
    (testDiscovery.replacedDefaults
      ? [...authoritativePatterns]
      : Array.from(new Set([...authoritativePatterns, ...defaultIncludesFor(declaredFrameworks.frameworks)])));
  const testExcludePatterns = options.testPatterns
    ? []
    : [...defaultExcludesFor(declaredFrameworks.frameworks), ...testDiscovery.excludeGlobs];
  const { locations: tests, filePaths: testFilePaths } = discoverTests(
    repoPath,
    testPatterns,
    excludeDirs,
    {
      excludePatterns: testExcludePatterns,
      // When the repository own declaration is in force it is the whole story, so nothing may
      // override the excludes it also declared. Otherwise DiffCI conventional patterns still win,
      // as they have since Phase 01.
      authoritativePatterns: testDiscovery.replacedDefaults ? [] : authoritativePatterns,
      ignoreRegexes: compileIgnoreRegexes(testDiscovery.ignoreRegexSources),
      roots: testDiscovery.roots,
    },
  );
  const workflows = discoverWorkflows(repoPath);
  const configFiles = discoverConfigFiles(repoPath, excludeDirs);
  const entryPoints = classifyEntryPoints(
    repoPath,
    isNext,
    roots,
    excludeDirs,
  );

  const testFileCount = testFilePaths.length;
  const lockfile =
    packageManager === "npm"
      ? "package-lock.json"
      : packageManager === "yarn"
        ? "yarn.lock"
        : packageManager === "pnpm"
          ? "pnpm-lock.yaml"
          : packageManager === "bun"
            ? (existsSync(join(repoPath, "bun.lockb")) ? "bun.lockb" : "bun.lock")
            : undefined;

  const nextConfigFile = findConfig(repoPath, "next.config");

  return {
    packageManager,
    packageJson: {
      name: packageJsonRaw?.name,
      version: packageJsonRaw?.version,
      scripts,
      dependencies,
      devDependencies,
    },
    lockfile,
    tsconfig,
    nextConfig: {
      exists: !!nextConfigFile,
      file: nextConfigFile,
    },
    sourceRoots: roots,
    tests,
    testFilePaths,
    testPatterns: [...testPatterns],
    testExcludePatterns: [...testExcludePatterns],
    testAuthoritativePatterns: testDiscovery.replacedDefaults ? [] : [...authoritativePatterns],
    testIgnoreRegexSources: [...testDiscovery.ignoreRegexSources],
    testRoots: [...testDiscovery.roots],
    testRunnerConfigs: testDiscovery.configs,
    diffciConfig,
    testUniverse: {
      declaredFrameworks: declaredFrameworks.frameworks,
      frameworkEvidence: declaredFrameworks.evidence,
      discoveredTestFiles: testFilePaths.length,
      // A repository that declares a test framework and in which DiffCI can find no test file at all
      // is a repository DiffCI does not understand. Recorded as a fact here; acted on in
      // ImpactAnalyzer, which must fall back rather than propose a selection against an empty
      // universe (Phase 01 F1, 2026-08-26).
      blindSpot: declaredFrameworks.frameworks.length > 0 && testFilePaths.length === 0,
    },
    workflows,
    configFiles,
    pathAliases: tsconfig?.pathAliases ?? [],
    entryPoints,
    stats: {
      sourceFiles: roots.length,
      testFiles: testFileCount,
      workflowFiles: workflows.length,
      configFiles: configFiles.length,
    },
  };
}
