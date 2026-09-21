import type { DiffCiRepositoryConfig } from "./repo-config.js";
import type { KnownTestFramework } from "./test-framework.js";
import type { TestRunnerConfig } from "./test-discovery.js";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "unknown";

export interface PathAlias {
  pattern: string;
  substitutions: string[];
}

export interface SourceRoot {
  path: string;
  kind: "source" | "tests" | "scripts" | "operations" | "app" | "api";
}

export interface TestLocation {
  glob: string;
  count: number;
}

export interface Workflow {
  path: string;
  name?: string;
}

export interface EntryPoint {
  path: string;
  kind:
    | "next-page"
    | "next-layout"
    | "next-route"
    | "next-api"
    | "next-loading"
    | "next-error"
    | "next-template"
    | "script"
    | "test"
    | "unknown";
}

export interface RepositoryProfile {
  /** Adapter coverage and concrete Go test-file to package routing. */
  adapters?: { id: string; version: string; blockers: string[] }[];
  adapterBlockers?: string[];
  goTestPackages?: Record<string, string>;
  goTestEnvironment?: Record<string, string>;
  packageManager: PackageManager;
  packageJson: {
    name?: string;
    version?: string;
    scripts: Record<string, string>;
    dependencies: string[];
    devDependencies: string[];
  };
  lockfile?: string;
  tsconfig?: {
    path: string;
    baseUrl?: string;
    pathAliases: PathAlias[];
    allowJs: boolean;
    include: string[];
    exclude: string[];
  };
  nextConfig?: {
    exists: boolean;
    file?: string;
  };
  sourceRoots: SourceRoot[];
  tests: TestLocation[];
  /** Repo-relative paths of every individual test file discovered (same match as `tests`,
   * unaggregated). The authoritative source for "all tests" callers that need real file
   * paths rather than glob-pattern strings (e.g. per-test PATH-baseline comparisons). */
  testFilePaths: string[];
  /** Effective test-file globs (DEFAULT_TEST_PATTERNS + test-runner config includes) - the ONE
   * definition of "is this a test?" shared by analyzer discovery, graph node flags and impact
   * classification (src/repo/test-discovery.ts). Optional for fixture compatibility; absent = defaults. */
  testPatterns?: string[];
  /** Default exclude globs of the frameworks this repository declares (e.g. ava's `**\/fixtures\/**`).
   * They disqualify only files that a framework's DEFAULT includes pulled in - never one the
   * repository itself named. Absent = no exclusions. */
  testExcludePatterns?: string[];
  /** The subset of `testPatterns` whose match is final: DiffCI's conventional `.test.`/`.spec.`
   * globs and every glob the repository declared explicitly in its own runner config. */
  testAuthoritativePatterns?: string[];
  /** Jest `testPathIgnorePatterns` regex sources from the repository own config, when its
   * declaration is in force. Carried on the profile so analyzer discovery, graph node flags and
   * impact classification cannot disagree about what the RUNNER can execute (defect 17). */
  testIgnoreRegexSources?: string[];
  /** Jest `roots`, likewise. Empty or absent means no root restriction. */
  testRoots?: string[];
  /** Test-runner configs found at the repo root, with their include globs, invoking scripts and family. */
  testRunnerConfigs?: TestRunnerConfig[];
  /** What this repository declares about how DiffCI should treat it (src/repo/repo-config.ts).
   * Absent means the repository has declared nothing, which is not the same as a default. */
  diffciConfig?: DiffCiRepositoryConfig;
  /** What the repository declares it tests with, and whether DiffCI could actually see any of it
   * (Phase 01, 2026-08-26). Optional for fixture compatibility; absent means "not evaluated", which
   * is treated as no blind spot rather than as one. */
  testUniverse?: {
    declaredFrameworks: KnownTestFramework[];
    /** How each framework was detected - "dependency:<pkg>" or "script:<name>". */
    frameworkEvidence: Record<string, string>;
    discoveredTestFiles: number;
    /** True when the repository declares a test framework and zero test files were discovered - the
     * engine does not understand this repository's test layout, and must not propose a selection
     * against an empty universe. */
    blindSpot: boolean;
  };
  workflows: Workflow[];
  configFiles: string[];
  pathAliases: PathAlias[];
  entryPoints: EntryPoint[];
  stats: {
    sourceFiles: number;
    testFiles: number;
    workflowFiles: number;
    configFiles: number;
  };
}

export type DependencyEdgeKind =
  | "import"
  | "type-import"
  | "re-export"
  | "dynamic-import"
  | "require"
  | "asset";

export type DependencyResolution =
  | "internal-source"
  | "external-package"
  | "platform-builtin"
  | "internal-asset"
  | "unresolved";

export interface DependencyEdge {
  from: string;
  to: string;
  kind: DependencyEdgeKind;
}

export interface DependencyGraphNode {
  path: string;
  isSource: boolean;
  isAsset: boolean;
  assetType?: string;
  isTest: boolean;
  isEntryPoint: boolean;
}

export interface DependencyGraph {
  nodes: DependencyGraphNode[];
  edges: DependencyEdge[];
  forward: Record<string, string[]>;
  reverse: Record<string, string[]>;
  dependenciesOf(filePath: string): string[];
  dependentsOf(filePath: string): string[];
  transitiveDependenciesOf(filePath: string): string[];
  transitiveDependentsOf(filePath: string): string[];
}

export interface UnresolvedDependency {
  importer: string;
  specifier: string;
  reason: string;
  dynamic: boolean;
  typeOnly: boolean;
}

export interface ResolutionReference {
  resolution: DependencyResolution;
  specifier: string;
  importer: string;
  kind: DependencyEdgeKind;
  dynamic: boolean;
}

export interface ResolutionCounts {
  internalSource: number;
  internalAsset: number;
  externalPackage: number;
  platformBuiltin: number;
  unresolved: number;
}

export type GraphConfidence = "COMPLETE" | "PARTIAL" | "UNSAFE";

export interface GraphIntegrityFinding {
  level: "critical" | "warning";
  message: string;
}

export interface GraphIntegrityReport {
  findings: GraphIntegrityFinding[];
  criticalCount: number;
  warningCount: number;
  stats: {
    nodeCount: number;
    sourceNodeCount: number;
    assetNodeCount: number;
    edgeCount: number;
    assetEdgeCount: number;
  };
}

export interface GraphPerformanceMetrics {
  durationMs: number;
  heapUsedMb?: number;
  heapAfterExtractionMb?: number;
  filesDiscovered: number;
  filesParsed: number;
}

export interface DependencyGraphResult {
  /** Missing framework/language relationships are global, not reachability-narrowable. */
  adapterBlockers?: string[];
  graph: DependencyGraph;
  profile: RepositoryProfile;
  unresolved: UnresolvedDependency[];
  references: ResolutionReference[];
  counts: ResolutionCounts;
  externalReferences: number;
  platformBuiltinReferences: number;
  internalAssetEdges: number;
  performance: GraphPerformanceMetrics;
  confidence: GraphConfidence;
  integrity: GraphIntegrityReport;
  /** Stage 1B (2026-08-21): whether TS project-reference resolution was used anywhere in this graph -
   * exposed so refineConfidenceForDelta() can correctly cap a per-delta-narrowed confidence at PARTIAL
   * rather than assuming COMPLETE, matching computeConfidence()'s own priority (project-reference use
   * caps confidence even when nothing else flags a problem). Previously computed but never exposed. */
  resolvedViaProjectReferences: boolean;
}
