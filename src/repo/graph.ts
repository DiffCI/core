import { existsSync, readdirSync } from "node:fs";
import { createTestFileMatcher, DEFAULT_TEST_FILE_MATCHER, testFileMatcherForProfile, type TestFileMatcher } from "./test-discovery.js";
import { isBuiltin } from "node:module";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { adapterFiles, REPOSITORY_ADAPTERS } from "./adapters/index.js";
import { analyzeRepository, type AnalyzeRepositoryOptions } from "./analyzer.js";
import type {
  DependencyEdge,
  DependencyEdgeKind,
  DependencyGraph,
  DependencyGraphNode,
  DependencyGraphResult,
  GraphConfidence,
  GraphIntegrityFinding,
  GraphIntegrityReport,
  GraphPerformanceMetrics,
  ResolutionReference,
  SourceRoot,
  UnresolvedDependency,
} from "./types.js";

interface ImportRef {
  specifier: string;
  kind: DependencyEdgeKind;
  dynamic: boolean;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
]);

const ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".jsonc",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".md",
  ".txt",
]);

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isSourceFileName(fileName: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function isAssetFileName(fileName: string): boolean {
  return ASSET_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function isNodeBuiltin(specifier: string): boolean {
  return isBuiltin(specifier);
}


function toRelativeInternal(
  repoPath: string,
  absolutePath: string,
): string | undefined {
  const rel = toPosix(normalize(relative(repoPath, absolutePath)));
  if (rel.startsWith("..")) return undefined;
  if (rel === "node_modules" || rel.startsWith("node_modules/")) return undefined;
  return rel;
}

function isExcludedPath(rel: string, excludeDirs: string[]): boolean {
  return excludeDirs.some(
    (dir) => rel === dir || rel.startsWith(`${dir}/`),
  );
}

function extractImportRefs(sourceFile: ts.SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        const isTypeOnly = node.importClause?.isTypeOnly ?? false;
        const kind: DependencyEdgeKind = isTypeOnly ? "type-import" : "import";
        refs.push({ specifier: specifier.text, kind, dynamic: false });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        const kind: DependencyEdgeKind = node.isTypeOnly ? "type-import" : "re-export";
        refs.push({ specifier: specifier.text, kind, dynamic: false });
      }
    } else if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && firstArg) {
        if (ts.isStringLiteral(firstArg)) {
          refs.push({
            specifier: firstArg.text,
            kind: "dynamic-import",
            dynamic: true,
          });
        } else {
          refs.push({
            specifier: firstArg.getText(sourceFile).slice(0, 200),
            kind: "dynamic-import",
            dynamic: true,
          });
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        firstArg &&
        ts.isStringLiteral(firstArg)
      ) {
        refs.push({
          specifier: firstArg.text,
          kind: "require",
          dynamic: false,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs;
}

class DependencyGraphImpl implements DependencyGraph {
  readonly nodes: DependencyGraphNode[];
  readonly edges: DependencyEdge[];
  readonly forward: Record<string, string[]> = {};
  readonly reverse: Record<string, string[]> = {};

  constructor(
    sourcePaths: ReadonlySet<string>,
    assetPaths: ReadonlySet<string>,
    edges: DependencyEdge[],
    private repoPath: string,
    isTestFile: TestFileMatcher = DEFAULT_TEST_FILE_MATCHER,
  ) {
    this.edges = [...edges].sort(DependencyGraphImpl.compareEdges);
    this.nodes = [
      ...Array.from(sourcePaths).map((p) => ({
        path: p,
        isSource: true,
        isAsset: false,
        isTest: isTestFile(p),
        isEntryPoint: false,
      })),
      ...Array.from(assetPaths).map((p) => ({
        path: p,
        isSource: false,
        isAsset: true,
        assetType: extname(p).toLowerCase(),
        isTest: false,
        isEntryPoint: false,
      })),
    ].sort((a, b) => a.path.localeCompare(b.path));

    for (const node of this.nodes) {
      this.forward[node.path] = [];
      this.reverse[node.path] = [];
    }

    for (const edge of this.edges) {
      if (this.forward[edge.from] !== undefined) {
        this.forward[edge.from]!.push(edge.to);
      }
      if (this.reverse[edge.to] !== undefined) {
        this.reverse[edge.to]!.push(edge.from);
      }
    }

    for (const key of Object.keys(this.forward)) {
      this.forward[key] = [...new Set(this.forward[key]!)].sort();
    }
    for (const key of Object.keys(this.reverse)) {
      this.reverse[key] = [...new Set(this.reverse[key]!)].sort();
    }
  }

  private static compareEdges(a: DependencyEdge, b: DependencyEdge): number {
    return (
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind)
    );
  }

  dependenciesOf(filePath: string): string[] {
    const rel = this.normalizeQuery(filePath);
    return this.forward[rel] ?? [];
  }

  dependentsOf(filePath: string): string[] {
    const rel = this.normalizeQuery(filePath);
    return this.reverse[rel] ?? [];
  }

  transitiveDependenciesOf(filePath: string): string[] {
    return this.transitiveTraversal(filePath, "forward");
  }

  transitiveDependentsOf(filePath: string): string[] {
    return this.transitiveTraversal(filePath, "reverse");
  }

  private transitiveTraversal(
    filePath: string,
    direction: "forward" | "reverse",
  ): string[] {
    const rel = this.normalizeQuery(filePath);
    const visited = new Set<string>();
    const queue: string[] = [rel];
    const result: string[] = [];
    const adjacency = direction === "forward" ? this.forward : this.reverse;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current !== rel) result.push(current);
      for (const next of adjacency[current] ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }

    return result.sort();
  }

  private normalizeQuery(filePath: string): string {
    const rel = toPosix(normalize(relative(this.repoPath, resolve(this.repoPath, filePath))));
    return rel;
  }
}

/** Restores a cached graph. `testPatterns` (from the cached profile) keeps isTest flags consistent with
 * the test universe the graph was built under; without it the pre-2026-08-23 defaults apply. */
export function hydrateDependencyGraph(graph: DependencyGraph, repoPath: string, testPatterns?: readonly string[]): DependencyGraph {
  const sourcePaths = new Set(graph.nodes.filter((n) => n.isSource).map((n) => n.path));
  const assetPaths = new Set(graph.nodes.filter((n) => n.isAsset).map((n) => n.path));
  return new DependencyGraphImpl(sourcePaths, assetPaths, graph.edges, repoPath, testPatterns ? createTestFileMatcher(testPatterns) : DEFAULT_TEST_FILE_MATCHER);
}

/**
 * TypeScript "solution style" tsconfigs (`"files": [], "references": [...]`) parse to zero
 * root file names via ts.parseJsonConfigFileContent — it does not expand `references` into
 * `fileNames` (that requires solution-build APIs this module doesn't otherwise use). Left
 * unhandled, that produces an empty ts.Program and therefore an empty dependency graph,
 * which computeConfidence() would otherwise happily report as "COMPLETE" (nothing to
 * flag as unresolved when there's nothing to resolve). Recursively resolve each
 * referenced project's own file list and compiler options so the program actually
 * contains the real source files.
 */
function resolveProjectReferenceInputs(
  configPath: string,
  visited: Set<string>,
): { fileNames: string[]; optionsList: ts.CompilerOptions[] } {
  const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
  const normalized = ts.sys.resolvePath ? ts.sys.resolvePath(configPath) : configPath;
  if (visited.has(normalized)) return collected; // guard against reference cycles
  visited.add(normalized);

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error || !config) return collected;

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath), undefined, configPath);
  collected.fileNames.push(...parsed.fileNames);
  if (parsed.fileNames.length > 0) collected.optionsList.push(parsed.options);

  for (const ref of parsed.projectReferences ?? []) {
    const refConfigPath = ts.resolveProjectReferencePath(ref);
    if (!ts.sys.fileExists(refConfigPath)) continue;
    const nested = resolveProjectReferenceInputs(refConfigPath, visited);
    collected.fileNames.push(...nested.fileNames);
    collected.optionsList.push(...nested.optionsList);
  }

  return collected;
}

const FALLBACK_SCAN_IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "tmp", "temp"]);
/** Bound on how many files this walk will ever collect, purely as a defensive cap against pathological
 * repos - real source roots are never anywhere close to this in practice. */
const FALLBACK_SCAN_MAX_FILES = 20_000;

/** Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): recursively collects real
 * TS/JS source file paths under the given source-root directories. Used only as a fallback when the
 * repository's own tsconfig scopes the compiler Program to something that excludes real source
 * entirely (see the doc comment on the caller below) - independent of, and not a replacement for, the
 * repo's own tsconfig-driven file discovery. */
function discoverFallbackSourceFiles(repoPath: string, sourceRoots: SourceRoot[]): string[] {
  const found: string[] = [];
  function walk(dirAbs: string): void {
    if (found.length >= FALLBACK_SCAN_MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // root doesn't exist / unreadable - not this function's concern to report, just skip it
    }
    for (const entry of entries) {
      if (found.length >= FALLBACK_SCAN_MAX_FILES) return;
      if (FALLBACK_SCAN_IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isSourceFileName(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(full);
      }
    }
  }
  for (const root of sourceRoots) walk(join(repoPath, root.path));
  return found;
}

/** Monorepo layouts without a root `tsconfig.json` (a `tsconfig.json` per package under per-package
 * subdirectories such as `packages/`, `apps/`, or `crates/` - e.g. biomejs/biome, calcom/cal.diy) are
 * never seen by `ts.findConfigFile()`, which starts at the repository root and walks UP, never DOWN
 * into subdirectories. This recursively discovers those per-package `tsconfig.json` files so the graph
 * can still be built from the repository's real TypeScript surface instead of crashing. Mirrors the
 * ignore set used by the source-file fallback scan so `node_modules` / build output / VCS internals are
 * never descended into. */
const NESTED_TSCONFIG_IGNORED_DIRS = FALLBACK_SCAN_IGNORED_DIRS;
/** Defensive cap on how many tsconfig files the nested walk will ever collect, mirroring the
 * source-file fallback's own bound - real monorepos have one per package, nowhere near this. */
const NESTED_TSCONFIG_MAX_FILES = 1_000;

export function discoverNestedTsconfigPaths(repoPath: string): string[] {
  const found: string[] = [];
  function walk(dirAbs: string): void {
    if (found.length >= NESTED_TSCONFIG_MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory - skip it, not this function's concern to report
    }
    for (const entry of entries) {
      if (found.length >= NESTED_TSCONFIG_MAX_FILES) return;
      if (NESTED_TSCONFIG_IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "tsconfig.json") {
        found.push(full);
      }
    }
  }
  walk(repoPath);
  // Deterministic order: the option-merge below is "last wins", so a stable source order makes the
  // merged compiler options reproducible across filesystems (readdir order is OS-dependent).
  return found.sort();
}

function createProgram(
  repoPath: string,
  fallbackSourceRoots: SourceRoot[] = [],
  additionalSources: string[] = [],
): {
  program: ts.Program;
  options: ts.CompilerOptions;
  fileNames: readonly string[];
  resolvedViaProjectReferences: boolean;
} {
  // Phase 01 F5 (2026-08-26). This was `ts.findConfigFile(repoPath, ...)`, which starts at repoPath
  // and walks UP - so a repository cloned beneath any directory containing a tsconfig.json was
  // silently analysed against that ANCESTOR's project instead of its own. Flagged as a known latent
  // bug in src/research/repository/collector.ts and left unfixed since. It never bit the container
  // pipeline (clones land at /repos/<name>, with nothing above them) but it corrupts every local run,
  // which is precisely how this phase's own verification is done. Clamped to the repository root:
  // identical behaviour when a root tsconfig exists, and no escape when it does not.
  const rootConfigCandidate = join(repoPath, "tsconfig.json");
  const configPath = ts.sys.fileExists(rootConfigCandidate) ? rootConfigCandidate : undefined;

  let fileNames: readonly string[] = [];
  let options: ts.CompilerOptions = {};
  let resolvedViaProjectReferences = false;
  let configFileParsingDiagnostics: readonly ts.Diagnostic[] = [];

  if (configPath) {
    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
    if (error) {
      throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
    }

    const parsed = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );

    fileNames = parsed.fileNames;
    options = parsed.options;
    configFileParsingDiagnostics = parsed.errors;

    // Expand project references whenever the root DECLARES them - not only when the root itself
    // yielded no files.
    //
    // The condition was `fileNames.length === 0`, which assumed a solution-style root contributes
    // nothing of its own. Real ones do. Measured 2026-08-30:
    //
    //   typescript-eslint  root has "files": [] yet parses to 3 file names and 19 references. The gate
    //                      was false, references were never expanded, and the graph came back with 310
    //                      nodes of which 308 were tests and TWO were non-test files - the repository's
    //                      entire source absent, while ast-spec/tsconfig.build.json alone holds 253
    //                      files two levels down.
    //   babel              the same gate, masked: its root `include` pulls in ~500 files directly, so
    //                      the graph looked plausible at 511 nodes while holding 421 of 697
    //                      packages/*/src files - 60% coverage, silently.
    //
    // THE INVARIANT IS A UNION, not a replacement: the program contains the root project's own inputs
    // AND the recursively resolved reference inputs. Replacing would delete Babel's 421 root-included
    // files the moment expansion began working for it.
    if (parsed.projectReferences && parsed.projectReferences.length > 0) {
      const visited = new Set<string>([ts.sys.resolvePath ? ts.sys.resolvePath(configPath) : configPath]);
      const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
      for (const ref of parsed.projectReferences) {
        const refConfigPath = ts.resolveProjectReferencePath(ref);
        if (!ts.sys.fileExists(refConfigPath)) continue;
        const nested = resolveProjectReferenceInputs(refConfigPath, visited);
        collected.fileNames.push(...nested.fileNames);
        collected.optionsList.push(...nested.optionsList);
      }
      if (collected.fileNames.length > 0) {
        fileNames = Array.from(new Set([...fileNames, ...collected.fileNames]));
        // Best-effort merge, as before: later-referenced projects' options win over earlier ones. The
        // root's own options are applied LAST so the config the caller actually pointed at still wins -
        // which is also what keeps a mixed root's existing behaviour unchanged. This is an
        // approximation (referenced projects can legitimately differ) but it is used only for import
        // resolution and AST parsing here, not for type checking.
        const mergedReferences = collected.optionsList.reduce((merged, opts) => ({ ...merged, ...opts }), {} as ts.CompilerOptions);
        options = { ...mergedReferences, ...options };
        resolvedViaProjectReferences = true;
      }
    }
  } else {
    // No root tsconfig.json. Instead of throwing (which previously crashed the whole analysis for
    // every monorepo with only per-package tsconfigs - biomejs/biome, calcom/cal.diy, and the 2026-08-24
    // blind baseline's "tsconfig crash" finding), discover the repository's nested per-package tsconfigs
    // and merge their inputs exactly like project references. The same "multiple sub-projects' compiler
    // options merged into one best-effort approximation" caveat applies, so resolvedViaProjectReferences
    // is set to cap confidence at PARTIAL. If there is genuinely no tsconfig anywhere (pure-Rust repo,
    // plain-JS repo), fileNames stays empty and computeConfidence() reports UNSAFE - a conservative
    // FALLBACK rather than an unhandled exception.
    const nestedConfigPaths = discoverNestedTsconfigPaths(repoPath);
    if (nestedConfigPaths.length > 0) {
      const visited = new Set<string>();
      const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
      for (const nestedPath of nestedConfigPaths) {
        const nested = resolveProjectReferenceInputs(nestedPath, visited);
        collected.fileNames.push(...nested.fileNames);
        collected.optionsList.push(...nested.optionsList);
      }
      if (collected.fileNames.length > 0) {
        fileNames = Array.from(new Set(collected.fileNames));
        options = collected.optionsList.reduce((merged, opts) => ({ ...merged, ...opts }), {} as ts.CompilerOptions);
        resolvedViaProjectReferences = true;
      }
    }
  }

  // Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md), root-caused in Stage 1A
  // (sindresorhus/execa): a real repository's tsconfig can exist and be entirely valid (so the repo is
  // correctly not excluded by the "no tsconfig" rule) yet be scoped ONLY to declaration-file validation
  // via an explicit "files" list with no "include" glob (a genuine, non-niche pattern for ESM-first
  // packages that hand-author both .js source and a separate .d.ts for `tsc`-only type-checking) - the
  // resulting Program never loads any real .js/.ts implementation source at all, producing a graph with
  // (effectively) zero source nodes despite real, testable code existing. Trigger is narrow and
  // specific: the tsconfig's own file list resolved to at least one file, but EVERY one of them is a
  // declaration file - not "the file list is merely small" (a genuinely small, correctly-scoped
  // tsconfig should not be second-guessed). When triggered, independently-discovered source files
  // (analyzer.ts's own glob-based source-root scan, entirely separate from and unaffected by the
  // tsconfig's own file-list scoping) are ADDED to the Program's root files - never replacing what the
  // tsconfig specified, only supplementing it.
  if (fileNames.length > 0 && fileNames.every((f) => f.endsWith(".d.ts")) && fallbackSourceRoots.length > 0) {
    const discovered = discoverFallbackSourceFiles(repoPath, fallbackSourceRoots);
    if (discovered.length > 0) {
      fileNames = Array.from(new Set([...fileNames, ...discovered]));
      // Real-world validation finding (2026-08-21, docs/research/2026-08-21-stage1b-*.md): merely
      // adding discovered .js files to rootNames is not sufficient - a tsconfig scoped to declaration-
      // only validation (this fallback's whole trigger condition) was never designed to compile .js at
      // all, so it correctly never sets allowJs. Without it, TypeScript does not treat the
      // fallback-added .js files as valid program members for AST/import extraction purposes. Only
      // forced on when the fallback itself already fired - never changes behavior for a repo whose
      // tsconfig was never mis-scoped in the first place.
      options = { ...options, allowJs: true };
    }
  }

  if (additionalSources.length) {
    fileNames = [...new Set([...fileNames, ...additionalSources])];
    options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, ...options, allowJs: true };
  }
  const program = ts.createProgram({
    rootNames: fileNames,
    options,
    configFileParsingDiagnostics,
  });

  return { program, options, fileNames, resolvedViaProjectReferences };
}

function classifySpecifier(specifier: string): "relative" | "absolute" | "alias" | "package" {
  if (specifier.startsWith("`./") || specifier.startsWith("`../")) return "relative";
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (specifier.startsWith("`/")) return "absolute";
  if (specifier.startsWith("/")) return "absolute";
  if (specifier.startsWith("`@/")) return "alias";
  if (specifier.startsWith("@/")) return "alias";
  if (specifier.startsWith("`~/")) return "alias";
  if (specifier.startsWith("~/")) return "alias";
  if (specifier.startsWith("`#")) return "alias";
  if (specifier.startsWith("#")) return "alias";
  return "package";
}

function expandAliasCandidates(
  specifier: string,
  aliases: { pattern: string; substitutions: string[] }[],
  repoPath: string,
): string[] {
  for (const { pattern, substitutions } of aliases) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length);
        return substitutions.map((sub) => {
          const base = sub.endsWith("/*") ? sub.slice(0, -1) : sub;
          return resolve(repoPath, base, rest);
        });
      }
    } else if (specifier === pattern || specifier.startsWith(`${pattern}/`)) {
      return substitutions.map((sub) => resolve(repoPath, sub));
    }
  }
  return [];
}

/**
 * Bundler import-query suffixes (2026-08-23, deepseek-harness Phase 5): Vite/webpack allow
 * `import css from "../styles/base.css?inline"` / `?raw` / `?url` / `?worker` (no `#` handling). The
 * query changes HOW the bundler loads the file, never WHICH file - so for resolution purposes the
 * specifier is the path before the first `?`/`#`. Without this every such import was "unresolved
 * internal module", which made the whole ui-theme package UNSAFE and blocked 5 of 30 deepseek merges
 * on nothing else. Applied only to relative/absolute/alias specifiers (bare package names cannot carry
 * a query); the original specifier is still what gets recorded in references.
 */
function stripImportQuery(specifier: string): string {
  // Only `?` - a leading `#` is a Node subpath import (`#internal/x`), and `#fragment` is not a bundler convention.
  const cut = specifier.indexOf("?");
  return cut <= 0 ? specifier : specifier.slice(0, cut);
}

function findAssetCandidate(
  importerAbs: string,
  specifier: string,
  aliases: { pattern: string; substitutions: string[] }[],
  repoPath: string,
): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    candidates.push(resolve(dirname(importerAbs), specifier));
  } else if (specifier.startsWith("/")) {
    candidates.push(resolve(repoPath, specifier.slice(1)));
  } else {
    candidates.push(...expandAliasCandidates(specifier, aliases, repoPath));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface BuildDependencyGraphOptions extends AnalyzeRepositoryOptions {}

export async function buildDependencyGraph(
  options: BuildDependencyGraphOptions = {},
): Promise<DependencyGraphResult> {
  const start = process.hrtime.bigint();
  const repoPath = options.repoPath ? resolve(options.repoPath) : process.cwd();

  const profile = analyzeRepository(options);
  const files = adapterFiles(repoPath, options.excludeDirs);
  const context = { repoPath, files, profile };
  const contributions = REPOSITORY_ADAPTERS.filter((adapter) => adapter.detect(context)).map((adapter) => adapter.analyze(context));
  const adapterBlockers = contributions.flatMap((item) => item.blockers);
  if (contributions.some((item) => item.id === "go") && files.some((file) => /\.(?:[cm]?[jt]sx?|vue)$/.test(file))) {
    adapterBlockers.push("Mixed Go/JavaScript repositories require explicit cross-language dependencies; full validation required");
  }
  if (contributions.length && files.some((file) => /\.(?:py|rs|java|kt|cs|svelte|astro)$/.test(file))) {
    adapterBlockers.push("Unmodeled languages alongside an adapter require full validation");
  }
  profile.adapters = contributions.map(({ id, version, blockers }) => ({ id, version, blockers }));
  profile.goTestPackages = Object.assign({}, ...contributions.map((item) => item.testPackages));
  profile.goTestEnvironment = contributions.find((item) => item.id === "go")?.executionEnv;
  const adapterTests = contributions.flatMap((item) => item.testFiles);
  profile.testFilePaths = [...new Set([...profile.testFilePaths, ...adapterTests])].sort();
  if (profile.testUniverse) {
    profile.testUniverse.discoveredTestFiles = profile.testFilePaths.length;
    profile.testUniverse.blindSpot = (profile.testUniverse.declaredFrameworks.length > 0 || contributions.some((item) => item.id === "go")) && profile.testFilePaths.length === 0;
  }
  const entryPointPaths = new Set(profile.entryPoints.map((e) => e.path));

  const vueSources = contributions.some((item) => item.id === "vue")
    ? files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).map((file) => join(repoPath, file)) : [];
  // Compiler include/exclude controls typechecking, not the runner's test universe. Parse every
  // discovered JS/TS test so source changes can reach tests outside the compiler's root files.
  // Adding those tests only as leaf nodes silently loses their dependency edges (ky, 2026-09-19).
  const testSources = profile.testFilePaths
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => join(repoPath, file));
  let { program, options: compilerOptions, resolvedViaProjectReferences } = createProgram(repoPath, profile.sourceRoots, [...vueSources, ...testSources]);
  let moduleResolutionCache = ts.createModuleResolutionCache(
    repoPath,
    (x) => x,
    compilerOptions,
  );

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => sf.fileName && !sf.fileName.endsWith(".d.ts"));
  for (const item of contributions) {
    for (const virtual of item.virtualSources) {
      sourceFiles.push(ts.createSourceFile(join(repoPath, virtual.path), virtual.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
    }
  }

  const internalSourcePaths = new Set<string>();

  for (const sf of sourceFiles) {
    const rel = toRelativeInternal(repoPath, sf.fileName);
    if (rel && isSourceFileName(sf.fileName) && !isExcludedPath(rel, options.excludeDirs ?? [])) {
      internalSourcePaths.add(rel);
    }
  }

  const edges: DependencyEdge[] = contributions.flatMap((item) => item.edges);
  const unresolved: UnresolvedDependency[] = [];
  const references: ResolutionReference[] = [];
  const assetPaths = new Set<string>(contributions.flatMap((item) => item.assetPaths));
  for (const item of contributions) for (const path of item.sourcePaths) internalSourcePaths.add(path);
  const edgeKeys = new Set<string>(edges.map((edge) => `${edge.from}|${edge.to}|${edge.kind}`));

  function addEdge(from: string, to: string, kind: DependencyEdgeKind): void {
    const key = `${from}|${to}|${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  }

  function recordUnresolved(
    importerRel: string,
    ref: ImportRef,
    reason: string,
  ): void {
    unresolved.push({
      importer: importerRel,
      specifier: ref.specifier,
      reason,
      dynamic: ref.dynamic,
      typeOnly: ref.kind === "type-import",
    });
  }

  function recordReference(
    resolution: ResolutionReference["resolution"],
    importer: string,
    ref: ImportRef,
  ): void {
    references.push({
      resolution,
      specifier: ref.specifier,
      importer,
      kind: ref.kind,
      dynamic: ref.dynamic,
    });
  }

  function recordAssetEdge(importerRel: string, assetRel: string): void {
    assetPaths.add(assetRel);
    addEdge(importerRel, assetRel, "asset");
  }

  const filesParsed = sourceFiles.length;

  for (const sf of sourceFiles) {
    const importerRel = toRelativeInternal(repoPath, sf.fileName);
    if (!importerRel || !isSourceFileName(sf.fileName)) continue;
    if (isExcludedPath(importerRel, options.excludeDirs ?? [])) continue;

    const refs = extractImportRefs(sf);
    for (const ref of refs) {
      if (!ref.specifier) {
        recordUnresolved(importerRel, ref, "empty specifier");
        recordReference("unresolved", importerRel, ref);
        continue;
      }

      if (isNodeBuiltin(ref.specifier)) {
        recordReference("platform-builtin", importerRel, ref);
        continue;
      }

      const specifierCategory = classifySpecifier(ref.specifier);
      const resolvableSpecifier = specifierCategory === "relative" || specifierCategory === "absolute" || specifierCategory === "alias" ? stripImportQuery(ref.specifier) : ref.specifier;
      // TypeScript may resolve a Vue import to a declaration shim. Preserve the actual SFC edge.
      if (resolvableSpecifier.endsWith(".vue")) {
        const compilerAliases = Object.entries(compilerOptions.paths ?? {}).map(([pattern, substitutions]) => ({ pattern, substitutions }));
        const candidate = findAssetCandidate(sf.fileName, resolvableSpecifier, compilerAliases.length ? compilerAliases : profile.pathAliases, compilerOptions.baseUrl ?? repoPath);
        const target = candidate && toRelativeInternal(repoPath, candidate);
        if (target && internalSourcePaths.has(target)) {
          addEdge(importerRel, target, ref.kind);
          recordReference("internal-source", importerRel, ref);
          continue;
        }
        recordUnresolved(importerRel, ref, "Vue component not found in analyzed source inventory");
        recordReference("unresolved", importerRel, ref);
        continue;
      }
      const resolution = ts.resolveModuleName(
        resolvableSpecifier,
        sf.fileName,
        compilerOptions,
        ts.sys,
        moduleResolutionCache,
      );

      if (!resolution.resolvedModule || !resolution.resolvedModule.resolvedFileName) {
        const category = classifySpecifier(ref.specifier);
        if (category === "relative" || category === "absolute" || category === "alias") {
          const assetAbs = findAssetCandidate(
            sf.fileName,
            resolvableSpecifier,
            profile.pathAliases,
            repoPath,
          );
          if (assetAbs) {
            const assetRel = toRelativeInternal(repoPath, assetAbs);
            if (assetRel) {
              recordAssetEdge(importerRel, assetRel);
              recordReference("internal-asset", importerRel, ref);
              continue;
            }
          }
          recordUnresolved(importerRel, ref, "unresolved internal module");
          recordReference("unresolved", importerRel, ref);
        } else {
          recordReference("external-package", importerRel, ref);
        }
        continue;
      }

      const resolved = resolution.resolvedModule.resolvedFileName;
      const targetRel = toRelativeInternal(repoPath, resolved);

      if (targetRel && isSourceFileName(resolved)) {
        internalSourcePaths.add(targetRel);
        addEdge(importerRel, targetRel, ref.kind);
        recordReference("internal-source", importerRel, ref);
        continue;
      }

      if (targetRel && isAssetFileName(resolved)) {
        recordAssetEdge(importerRel, targetRel);
        recordReference("internal-asset", importerRel, ref);
        continue;
      }

      const category = classifySpecifier(ref.specifier);
      if (category === "relative" || category === "absolute" || category === "alias") {
        const reason = targetRel
          ? "resolved to non-source internal file"
          : "resolved outside repository";
        recordUnresolved(importerRel, ref, reason);
        recordReference("unresolved", importerRel, ref);
      } else {
        recordReference("external-package", importerRel, ref);
      }
    }
  }

  if (unresolved.some((ref) => ref.importer.endsWith(".vue") || stripImportQuery(ref.specifier).endsWith(".vue"))) {
    adapterBlockers.push("Unresolved Vue dependencies require full validation");
  }
  profile.adapterBlockers = [...adapterBlockers];

  // Keep adapter-provided test identities visible as well. JS/TS tests are parsed above; their
  // imports must not be replaced by disconnected leaf nodes merely because tsconfig excludes them.
  for (const testPath of profile.testFilePaths) {
    if (!internalSourcePaths.has(testPath) && !assetPaths.has(testPath)) internalSourcePaths.add(testPath);
  }

  const graph = new DependencyGraphImpl(internalSourcePaths, assetPaths, edges, repoPath, testFileMatcherForProfile(profile));

  for (const node of graph.nodes) {
    node.isEntryPoint = entryPointPaths.has(node.path);
  }

  const heapDuringBuildMb = process.memoryUsage
    ? Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
    : undefined;

  // Release the heavy TypeScript AST / program after graph extraction.
  program = undefined as unknown as ts.Program;
  moduleResolutionCache = undefined as unknown as ts.ModuleResolutionCache;
  if (typeof globalThis.gc === "function") {
    try { globalThis.gc(); } catch { /* ignore */ }
  }

  const heapAfterExtractionMb = process.memoryUsage
    ? Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
    : undefined;

  profile.stats.sourceFiles = graph.nodes.filter((n) => n.isSource).length;
  profile.stats.testFiles = graph.nodes.filter((n) => n.isTest).length;

  const integrity = validateDependencyGraph(graph);
  const dynamicUnresolvedCount = unresolved.filter((u) => u.dynamic).length;
  const confidence = adapterBlockers.length ? "UNSAFE" : computeConfidence(
    unresolved.length,
    dynamicUnresolvedCount,
    integrity.criticalCount,
    profile.stats.sourceFiles,
    resolvedViaProjectReferences,
  );

  const internalAssetEdges = edges.filter((e) => e.kind === "asset").length;
  const externalReferences = references.filter((r) => r.resolution === "external-package").length;
  const platformBuiltinReferences = references.filter(
    (r) => r.resolution === "platform-builtin",
  ).length;
  const counts = {
    internalSource: references.filter((r) => r.resolution === "internal-source").length,
    internalAsset: internalAssetEdges,
    externalPackage: externalReferences,
    platformBuiltin: platformBuiltinReferences,
    unresolved: unresolved.length,
  };

  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  const performance: GraphPerformanceMetrics = {
    durationMs,
    heapUsedMb: heapDuringBuildMb,
    heapAfterExtractionMb,
    filesDiscovered: filesParsed,
    filesParsed: filesParsed,
  };

  return {
    graph,
    adapterBlockers,
    profile,
    unresolved,
    references,
    counts,
    externalReferences,
    platformBuiltinReferences,
    internalAssetEdges,
    performance,
    confidence,
    integrity,
    resolvedViaProjectReferences,
  };
}

export type TypeScriptProjectKind = "root" | "nested" | "none";

/** Product eligibility includes native adapters; legacy TS corpus classification stays separate. */
export function classifyRepositoryProject(repoPath: string): { capable: boolean; reason: string } {
  const typescript = classifyTypeScriptProject(repoPath);
  if (typescript.capable) return typescript;
  const files = adapterFiles(repoPath);
  if (files.includes("go.mod")) return { capable: true, reason: "Go module (package-level analysis)" };
  if (files.some((file) => file.endsWith(".vue"))) return { capable: true, reason: "Vue single-file components" };
  return { capable: false, reason: "No TypeScript project, Vue components, or root Go module found" };
}

export interface TypeScriptProjectCapability {
  /** Whether createProgram() has any tsconfig at all to build a Program from. */
  capable: boolean;
  kind: TypeScriptProjectKind;
  /** Number of per-package tsconfigs found when `kind` is "nested". */
  nestedCount: number;
  reason: string;
}

/**
 * Can DiffCI build a dependency graph for this repository? (Phase 01 F3, 2026-08-26.)
 *
 * This exists so the eligibility gate cannot drift from what the graph builder can actually do -
 * which is exactly what happened. `src/repo/graph.ts` gained nested per-package tsconfig support on
 * 2026-08-24 (for biome and cal.diy); `collectMetadata()` kept refusing anything without a ROOT
 * tsconfig, with the message "DiffCI cannot analyze this repository". On the Phase 01 baseline both
 * `vitest-dev/vitest` and `facebook/docusaurus` were refused by that gate and then built real graphs
 * of 2118 and 1131 nodes. The message was not a limitation, it was out of date - and it cost roughly
 * 144 container launches a day before the ramp caught it.
 *
 * A nested-only layout is capable but not equivalent: createProgram() merges several sub-projects'
 * compiler options into one approximation, which caps graph confidence at PARTIAL. Callers should
 * report the kind rather than flatten it to a boolean.
 */
export function classifyTypeScriptProject(repoPath: string): TypeScriptProjectCapability {
  if (existsSync(join(repoPath, "tsconfig.json"))) {
    return { capable: true, kind: "root", nestedCount: 0, reason: "tsconfig.json at the repository root" };
  }
  const nested = discoverNestedTsconfigPaths(repoPath);
  if (nested.length > 0) {
    return {
      capable: true,
      kind: "nested",
      nestedCount: nested.length,
      reason: `no root tsconfig.json, but ${nested.length} per-package tsconfig.json file(s) the graph builder merges`,
    };
  }
  return {
    capable: false,
    kind: "none",
    nestedCount: 0,
    reason: "no tsconfig.json anywhere in the repository - there is no TypeScript project to build a graph from",
  };
}

export function validateDependencyGraph(graph: DependencyGraph): GraphIntegrityReport {
  const findings: GraphIntegrityFinding[] = [];
  const nodePaths = new Set(graph.nodes.map((n) => n.path));

  for (const edge of graph.edges) {
    if (!nodePaths.has(edge.from)) {
      findings.push({
        level: "critical",
        message: `Edge from nonexistent node: ${edge.from} -> ${edge.to}`,
      });
    }
    if (!nodePaths.has(edge.to)) {
      findings.push({
        level: "critical",
        message: `Edge to nonexistent node: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.from.startsWith("../") || edge.from.includes("/../")) {
      findings.push({
        level: "critical",
        message: `Edge path escapes repository: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.to.startsWith("../") || edge.to.includes("/../")) {
      findings.push({
        level: "critical",
        message: `Edge path escapes repository: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.from.includes("\\") || edge.to.includes("\\")) {
      findings.push({
        level: "critical",
        message: `Edge path contains backslash: ${edge.from} -> ${edge.to}`,
      });
    }
  }

  const expectedForward: Record<string, string[]> = {};
  const expectedReverse: Record<string, string[]> = {};
  for (const path of nodePaths) {
    expectedForward[path] = [];
    expectedReverse[path] = [];
  }
  for (const edge of graph.edges) {
    if (expectedForward[edge.from] !== undefined) {
      expectedForward[edge.from].push(edge.to);
    }
    if (expectedReverse[edge.to] !== undefined) {
      expectedReverse[edge.to].push(edge.from);
    }
  }

  for (const path of nodePaths) {
    const expectedF = [...new Set(expectedForward[path])].sort();
    const actualF = graph.forward[path]?.slice().sort() ?? [];
    if (JSON.stringify(expectedF) !== JSON.stringify(actualF)) {
      findings.push({
        level: "critical",
        message: `Forward adjacency mismatch for ${path}`,
      });
    }
    const expectedR = [...new Set(expectedReverse[path])].sort();
    const actualR = graph.reverse[path]?.slice().sort() ?? [];
    if (JSON.stringify(expectedR) !== JSON.stringify(actualR)) {
      findings.push({
        level: "critical",
        message: `Reverse adjacency mismatch for ${path}`,
      });
    }
  }

  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  for (const node of graph.nodes) {
    if (!connected.has(node.path) && !node.isEntryPoint) {
      findings.push({
        level: "warning",
        message: `Isolated node: ${node.path}`,
      });
    }
    if (!node.path) {
      findings.push({ level: "critical", message: "Node with empty path" });
    } else if (node.path.includes("\\")) {
      findings.push({
        level: "critical",
        message: `Malformed node path with backslash: ${node.path}`,
      });
    }
  }

  return {
    findings,
    criticalCount: findings.filter((f) => f.level === "critical").length,
    warningCount: findings.filter((f) => f.level === "warning").length,
    stats: {
      nodeCount: graph.nodes.length,
      sourceNodeCount: graph.nodes.filter((n) => n.isSource).length,
      assetNodeCount: graph.nodes.filter((n) => n.isAsset).length,
      edgeCount: graph.edges.length,
      assetEdgeCount: graph.edges.filter((e) => e.kind === "asset").length,
    },
  };
}

function computeConfidence(
  unresolvedCount: number,
  dynamicUnresolvedCount: number,
  integrityCriticalCount: number,
  sourceFileCount: number,
  resolvedViaProjectReferences: boolean,
): GraphConfidence {
  // An empty graph has nothing to flag as unresolved and nothing to violate integrity
  // checks, so without this it would fall through to "COMPLETE" — the worst possible
  // failure mode (confidently wrong rather than honestly unsure). Zero source files means
  // we could not build a trustworthy view of the repository at all.
  if (sourceFileCount === 0) return "UNSAFE";
  if (integrityCriticalCount > 0) return "UNSAFE";
  if (dynamicUnresolvedCount > 0) return "UNSAFE";
  if (unresolvedCount > 0) return "UNSAFE";
  // Project-reference resolution merges multiple sub-projects' compiler options into one
  // best-effort approximation (see resolveProjectReferenceInputs) rather than the exact
  // settings TypeScript itself would use per sub-project, so cap confidence at PARTIAL
  // even when nothing else flagged a problem.
  if (resolvedViaProjectReferences) return "PARTIAL";
  return "COMPLETE";
}

/** Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): per-delta refinement of a graph's
 * raw, delta-independent confidence(). Stage 1A's forensic investigation of all 7 fully-UNSAFE
 * repositories found that in 5 of 7, the unresolved-import count was under 0.1% of total graph edges
 * and confined to files structurally unrelated to the actual library/test surface (a build-tooling
 * script, a non-committed generated fixture, an optional peer-dependency shim) - yet computeConfidence()
 * unconditionally treats ANY unresolved import anywhere in the repository as disqualifying the ENTIRE
 * graph for EVERY delta, for as long as that one file's import stays unresolved, regardless of whether
 * the delta being analyzed has anything to do with it.
 *
 * This narrows that: an unresolved import only makes THIS delta's confidence untrustworthy if the
 * unresolved import's importer file is actually reachable from the delta's changed files (in either
 * direction - the changed file might depend on the incomplete file, or something reachable from the
 * changed file might). If none of the graph's unresolved imports are anywhere near this delta, the
 * graph's real incompleteness elsewhere cannot plausibly affect what can safely be determined about
 * THIS specific change.
 *
 * Deliberately NOT narrowed - these remain hard, global blockers regardless of the delta:
 * - `sourceFileCount === 0` (an empty graph gives no reachability information to reason about at all).
 * - `integrity.criticalCount > 0` (the graph's own internal structure is broken - a construction bug,
 *   not a property of any one file, so no delta-specific narrowing is meaningful).
 * These match computeConfidence()'s own priority order - both are checked before the unresolved-import
 * conditions this function narrows, and are returned as-is, unchanged, before reachability is examined.
 *
 * This function accepts the SAME confidence-relevant fields as computeConfidence() (rather than the
 * bare enum) precisely so a `confidence === "UNSAFE"` return value can be disambiguated: reachability
 * narrowing only applies when unresolved/dynamic-unresolved imports are the actual reason, never when
 * sourceFileCount or integrity triggered it. */
export function refineConfidenceForDelta(result: DependencyGraphResult, changedFiles: string[]): GraphConfidence {
  if (result.adapterBlockers?.length) return "UNSAFE";
  // Anything that was never UNSAFE in the first place passes through untouched - there is nothing to
  // narrow, and re-deriving sourceFileCount/integrity from raw fields here (rather than trusting the
  // already-computed confidence) would be both redundant and a real correctness risk: a caller's
  // profile object could be stale/unrelated to the graph actually being evaluated for reasons that have
  // nothing to do with this delta, and computeConfidence() already made the authoritative call once.
  if (result.confidence !== "UNSAFE") return result.confidence;
  // sourceFileCount===0 can never co-occur with unresolved.length>0 in a real graph (buildDependencyGraph
  // only ever records an unresolved entry for a file that isSourceFileName(), and any such file is
  // unconditionally added to internalSourcePaths before unresolved-detection ever runs - so
  // unresolved.length>0 guarantees sourceFileCount>=1 by construction). No need to re-check it
  // independently; result.confidence already reflects it correctly.
  //
  // integrity.criticalCount>0 is different - it's a genuinely independent condition (graph edge/adjacency
  // consistency, orthogonal to import resolution) that COULD co-occur with real unresolved imports, and
  // is never narrowable by reachability (an internally-broken graph gives no trustworthy reachability
  // information to reason about at all) - checked explicitly here, only within this already-UNSAFE
  // branch, not as an unconditional gate that could override a confidence that was never UNSAFE.
  if (result.integrity.criticalCount > 0) return "UNSAFE";
  if (result.unresolved.length === 0) return result.confidence;

  const reachableFromChanged = new Set<string>();
  for (const file of changedFiles) {
    for (const dep of result.graph.transitiveDependenciesOf(file)) reachableFromChanged.add(dep);
    for (const dep of result.graph.transitiveDependentsOf(file)) reachableFromChanged.add(dep);
  }
  const changedSet = new Set(changedFiles);

  const relevantUnresolved = result.unresolved.some((u) => changedSet.has(u.importer) || reachableFromChanged.has(u.importer));
  if (relevantUnresolved) return "UNSAFE";

  // None of the unresolved imports are reachable from this delta's changed files - narrow to what
  // confidence would have been without the unresolved-import trigger (still respecting the
  // project-references cap, exactly as computeConfidence()'s own final two branches do).
  return result.resolvedViaProjectReferences ? "PARTIAL" : "COMPLETE";
}

export function graphToJson(result: DependencyGraphResult): string {
  const { graph, profile, unresolved, references, counts, externalReferences, platformBuiltinReferences, internalAssetEdges, performance, confidence, integrity } = result;
  return JSON.stringify(
    {
      profile,
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
      },
      unresolved,
      references,
      counts,
      externalReferences,
      platformBuiltinReferences,
      internalAssetEdges,
      performance,
      confidence,
      integrity,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
