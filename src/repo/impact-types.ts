import type { ChangedFile, GitDelta } from "../git/types.js";
import type { DependencyGraph, DependencyGraphResult, GraphConfidence, RepositoryProfile } from "./types.js";

export type ImpactReason =
  | "DIRECT_CHANGE"
  | "DEPENDENCY"
  | "ASSET_DEPENDENCY"
  | "NEXT_LAYOUT_ANCESTOR"
  | "NEXT_ENTRY_POINT"
  | "NEXT_DESCENDANT_BREADTH"
  | "NEW_TEST_FILE"
  | "NEW_SCRIPT_FILE"
  | "NEW_ENTRY_POINT"
  | "CONFIG_GLOBAL"
  | "WORKFLOW_GLOBAL"
  | "DEPENDENCY_MANIFEST"
  | "LOCKFILE_GLOBAL"
  | "INFRASTRUCTURE_GLOBAL"
  | "DATABASE_GLOBAL"
  | "UNKNOWN_FILE"
  | "TEST_FIXTURE_OWNER"
  | "ALWAYS_RUN_POLICY"
  | "DELETED_FILE_LEGACY_DEPENDENTS"
  | "DELETED_FILE_UNKNOWABLE_GRAPH"
  | "RENAMED_FILE_LEGACY_IDENTITY"
  | "GRAPH_CONFIDENCE_UNSAFE"
  | "DIRECT_TEST_CHANGE"
  | "TEST_SELECTION_INVARIANT"
  | "TEST_UNIVERSE_EMPTY"
  | "EMPTY_DELTA";

export interface ImpactEvidencePath {
  changedFile: string;
  path: string[];
  pathKind: "dependents" | "dependencies";
}

export interface ImpactEvidence {
  reason: ImpactReason;
  changedFile: string;
  affectedFile?: string;
  message: string;
  path?: ImpactEvidencePath;
}

export interface EntryPointImpact {
  path: string;
  kind: string;
  reasons: ImpactReason[];
}

export interface ChangedImpact {
  file: ChangedFile;
  category: "source" | "asset" | "test" | "script" | "entry-point" | "config" | "workflow" | "infrastructure" | "database" | "docs" | "test-fixture" | "unknown";
  reasons: ImpactReason[];
}

export interface TestImpact {
  path: string;
  reasons: ImpactReason[];
  evidence: ImpactEvidence[];
}

export interface ImpactRiskSignal {
  level: "info" | "warning" | "critical";
  reason: ImpactReason;
  message: string;
  paths?: string[];
}

export interface ImpactSelectionCategory {
  path: string;
  category: "GRAPH_SELECTED" | "ALWAYS_RUN" | "GLOBAL_SAFETY" | "UNKNOWN";
}

export interface ImpactResult {
  changedFiles: ChangedImpact[];
  affectedSourceFiles: string[];
  affectedAssets: string[];
  affectedTests: TestImpact[];
  affectedEntryPoints: EntryPointImpact[];
  affectedScripts: string[];

  riskSignals: ImpactRiskSignal[];

  fallbackRequired: boolean;
  fallbackReasons: string[];

  analysisStatus: "SAFE_TO_PROPOSE" | "FALLBACK";

  /** Stage 1B (2026-08-21): the graph's confidence AFTER per-delta reachability narrowing
   * (refineConfidenceForDelta() in graph.ts), not the graph's raw/delta-independent confidence - this
   * is the value that actually drove fallbackRequired/analysisStatus above, and is what downstream
   * consumers (planner.ts's plan.safety.graphConfidence, the research pipeline's persisted
   * BenchmarkRecord.graphConfidence) should read instead of graphResult.confidence directly. */
  effectiveGraphConfidence: GraphConfidence;

  evidence: ImpactEvidence[];

  performance: {
    durationMs: number;
  };
}

export interface ImpactAnalyzer {
  analyze(delta: GitDelta, graphResult: DependencyGraphResult, profile: RepositoryProfile): ImpactResult;
}

export interface ValidationProposal {
  mode: "SELECTIVE" | "FULL";
  selectedTests: string[];
  selectedCategories: ImpactSelectionCategory[];
  alwaysRunChecks: string[];
  affectedEntryPoints: string[];
  reasons: ImpactEvidence[];
  fallbackReasons: string[];
}

export interface AnalyzeImpactOptions {
  repoPath?: string;
  includeEvidence?: boolean;
}

export interface ImpactContext {
  delta: GitDelta;
  graph: DependencyGraph;
  profile: RepositoryProfile;
  graphResult: DependencyGraphResult;
  options: AnalyzeImpactOptions;
}
