import type { DependencyEdge, RepositoryProfile } from "../types.js";

/** Adapters contribute to the same graph; uncertainty is never an empty successful graph. */
export interface AdapterContext {
  repoPath: string;
  files: readonly string[];
  profile: RepositoryProfile;
  vueComponentPaths?: readonly string[];
  recordVueRead?: (path: string) => void;
  vueAnalysisSession?: object;
}

export interface AdapterContribution {
  id: string;
  version: string;
  sourcePaths: string[];
  assetPaths: string[];
  edges: DependencyEdge[];
  /** Source understood by the existing TS resolver, retaining the original file identity. */
  virtualSources: Array<{ path: string; source: string }>;
  testFiles: string[];
  testPackages: Record<string, string>;
  executionEnv?: Record<string, string>;
  /** Global blockers: missing edges cannot be dismissed using graph reachability. */
  blockers: string[];
  fileBlockers?: Array<{ path: string; reason: string }>;
  performance?: { phasesMs: Record<string, number>; counts: Record<string, number> };
}

export interface RepositoryAdapter {
  id: string;
  version: string;
  kind: "language" | "framework";
  detect(context: AdapterContext): boolean;
  analyze(context: AdapterContext): AdapterContribution;
}

export function contribution(adapter: Pick<RepositoryAdapter, "id" | "version">): AdapterContribution {
  return { id: adapter.id, version: adapter.version, sourcePaths: [], assetPaths: [], edges: [], virtualSources: [], testFiles: [], testPackages: {}, blockers: [] };
}
