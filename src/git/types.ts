export type ChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "unknown";

export interface GitCommitRange {
  baseSha: string;
  headSha: string;
}

export interface ChangedFile {
  path: string;
  changeType: ChangeType;
  oldPath?: string;
  isBinary?: boolean;
  similarityScore?: number;
}

export interface GitDeltaSummary {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
  unmerged: number;
  unknown: number;
  total: number;
}

export interface GitDeltaAnalysis {
  empty: boolean;
  configChanged: boolean;
  dependencyManifestChanged: boolean;
  lockfileChanged: boolean;
  workflowChanged: boolean;
  infrastructureChanged: boolean;
  databaseChanged: boolean;
  /** Changed files whose content shows they cannot change how tests run - a workflow with no test
   * step, a package.json edit limited to fields outside the test script closure - and which therefore
   * did not set a global flag above. Tests may still read them, so ImpactAnalyzer resolves their
   * readers by reference and falls back to full validation when it cannot (2026-10-21). */
  referenceResolvedPaths?: string[];
  /** Test files a package.json test-list edit added to the test script (2026-10-28). They are part of
   * the suite from this change on, so ImpactAnalyzer selects them. */
  testScriptAddedPaths?: string[];
  /** Direct dependencies potentially affected by a modeled manifest/lockfile change. npm uses its
   * installed tree; Classic Yarn includes all roots because its lockfile omits peer relationships.
   * ImpactAnalyzer selects their importers or falls back. Absent when no narrowing happened. */
  changedDependencies?: string[];
  /** A modeled lockfile whose raw readers must still be resolved, including for semantic no-ops.
   * Its dependency effects are covered by changedDependencies. */
  dependencyLockfile?: "yarn.lock";
  /** The changed paths behind each flag above, so a fallback reason can name its files (2026-10-21:
   * "Configuration file(s) changed" was the most frequent reason in both telemetry cohorts and never
   * said which file). Absent on analyses produced before this field existed. */
  signalPaths?: Partial<Record<"config" | "dependencyManifest" | "lockfile" | "workflow" | "infrastructure" | "database", string[]>>;
}

export interface GitDelta extends GitCommitRange {
  files: ChangedFile[];
  directories: string[];
  summary: GitDeltaSummary;
  analysis: GitDeltaAnalysis;
}

/**
 * Inventory of every path present in the analyzed HEAD tree (`git ls-tree -r --name-only <head>`).
 * Produced once by analyzeGitDelta - the single canonical source - and consumed by relationship-based
 * classification in ImpactAnalyzer (e.g. translated-documentation companions). Deliberately a sibling
 * of `delta`, NOT a field on it: GitDelta is persisted/serialized in shadow records and this set is
 * large and reconstructible. Absent (undefined) when the listing fails - consumers must then stay
 * conservative (the companion rule is inert without it).
 */
export interface RepositoryInventory {
  headSha: string;
  files: ReadonlySet<string>;
  source: "git-ls-tree";
}

export interface GitDeltaSuccess {
  success: true;
  delta: GitDelta;
  /** HEAD file inventory; undefined if `git ls-tree` failed (never throws the whole analysis). */
  inventory?: RepositoryInventory;
}

export interface GitDeltaFailure {
  success: false;
  error: string;
  partialDelta?: GitDelta;
}

export type GitDeltaResult = GitDeltaSuccess | GitDeltaFailure;
