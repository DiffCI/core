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
