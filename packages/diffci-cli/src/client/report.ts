/**
 * The observation report - DiffCI's client-side wire format (Phase 02, 2026-08-26).
 *
 * WHY THIS EXISTS. Every earlier pipeline in this repository analysed OTHER people's repositories on
 * DiffCI's own infrastructure: a container cloned the source, built the graph, and kept the evidence.
 * That shape cannot be installed by a stranger - it asks them to hand a private tree to a service they
 * have not evaluated, before they have seen a single number. Phase 02 inverts it. The analysis runs on
 * the repository's own runner, inside its own CI, against a checkout it already has, and the only thing
 * that ever leaves is this document.
 *
 * So this file is the privacy boundary as much as it is a type. Everything DiffCI could learn about a
 * repository it does not host is a field below, and `payload` states in the document itself what the
 * document contains. If a future field would carry file CONTENT, an environment variable, or anything
 * a `git show` would print, it does not belong here - it belongs in a design conversation first.
 *
 * VERSIONING. `schema` is checked by consumers before anything else is read. A change that removes or
 * repurposes a field is a new version, not an edit to this one: reports are produced by a pinned action
 * inside someone else's CI, and old producers keep sending v1 long after the server has moved on.
 */

/** Wire identifier. Consumers MUST reject a document whose `schema` they do not recognise. */
export const OBSERVATION_SCHEMA = "diffci.observation.v1" as const;

/** How far the observation got. `REFUSED` is a stated limit, `ERROR` is a defect - never merge them. */
export type ObservationStatus = "OBSERVED" | "REFUSED" | "ERROR";

/**
 * The stage a refusal or error came from, in pipeline order. Recorded even on success (`complete`), so
 * a week of reports can be counted by where they stopped without parsing prose.
 */
export type ObservationStage =
  | "context"
  | "eligibility"
  | "delta"
  | "graph"
  | "impact"
  | "command"
  | "complete";

/** Which side produced the base/head pair, so a reader can tell a real PR range from a fallback. */
export type CommitRangeSource = "explicit-flags" | "pull-request-event" | "push-event" | "head-parent";

export interface ObservationCommitRange {
  baseSha: string;
  headSha: string;
  source: CommitRangeSource;
  /** Set when base and head diverged and the merge base was used as the real base. */
  mergeBaseSha?: string;
}

export interface ObservationRepository {
  provider: "github" | "unknown";
  /** "owner/name". The only repository identifier sent; never a URL carrying a token. */
  ownerName?: string;
  defaultBranch?: string;
  /** GitHub's numeric repository id when the environment supplies it - survives a rename. */
  providerRepositoryId?: string;
}

export interface ObservationCi {
  provider: "github-actions" | "local" | "unknown";
  runId?: string;
  runAttempt?: string;
  workflow?: string;
  job?: string;
  event?: string;
  ref?: string;
  /**
   * True when the trigger cannot be tied to a specific commit range without guessing (`schedule`,
   * `workflow_dispatch`). Recorded, not corrected.
   */
  syntheticTrigger?: boolean;
}

/**
 * What this document contains, stated by the document. A repository can verify the claim by reading the
 * file the action uploads - those are the same bytes that would be sent anywhere.
 */
export interface ObservationPayloadDescription {
  /** Repo-relative paths of changed and selected files. False when --redact-paths was used. */
  includesFilePaths: boolean;
  /** Always false. No field in this schema carries file content, and none may be added. */
  includesFileContents: false;
  /** Always false. The observer reads no process env beyond the CI variables recorded in `ci`. */
  includesEnvironment: false;
  /** Always false. Nothing here is derived from a credential, and none is ever requested. */
  includesCredentials: false;
  /** Set when paths were replaced by stable digests - see `redactPath` below. */
  pathRedaction?: "sha256-12";
}

/**
 * Evidence that observing did not change the thing being observed. This is the Phase 02 exit criterion
 * ("CI byte-identical") reduced to something a machine checks on every single run, rather than an
 * assurance given once at install time.
 */
export interface NonInterferenceEvidence {
  /** `git rev-parse HEAD` before and after. Unequal means the observer moved HEAD. */
  headShaBefore?: string;
  headShaAfter?: string;
  /** Digests of `git status --porcelain`. Unequal means the observer dirtied the working tree. */
  worktreeDigestBefore?: string;
  worktreeDigestAfter?: string;
  /** True only when both pairs above were captured and both matched. Absent capture is not a pass. */
  worktreeUnchanged: boolean;
  /** The report was written outside the repository working tree, so no later build step can see it. */
  reportWrittenOutsideRepository: boolean;
  /** Findings from the workflow guard (src/client/workflow-guard.ts), embedded on every run. */
  workflowFindings: WorkflowFinding[];
}

export type WorkflowFindingSeverity = "BLOCKING" | "WARNING" | "INFO";

export interface WorkflowFinding {
  severity: WorkflowFindingSeverity;
  /** Stable machine code, e.g. "JOB_IS_A_DEPENDENCY". Message text may be reworded; codes may not. */
  code: string;
  message: string;
  workflow: string;
  job?: string;
}

export interface TypeScriptProgramMetrics {
  sourceFileLoads: number;
  sourceFileLoadMs: number;
  failedSourceFileLoads: number;
  bundledLibraryLoads: number;
  bundledLibraryLoadMs: number;
  otherDeclarationLoads: number;
  otherDeclarationLoadMs: number;
  implementationLoads: number;
  implementationLoadMs: number;
}

/** Optional, additive metrics; unknown or incomplete core telemetry stays absent. */
export function readTypeScriptProgramMetrics(value: unknown): TypeScriptProgramMetrics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const counts = ["sourceFileLoads", "failedSourceFileLoads", "bundledLibraryLoads", "otherDeclarationLoads", "implementationLoads"] as const;
  const times = ["sourceFileLoadMs", "bundledLibraryLoadMs", "otherDeclarationLoadMs", "implementationLoadMs"] as const;
  if (counts.some((key) => typeof input[key] !== "number" || !Number.isInteger(input[key]) || (input[key] as number) < 0) ||
      times.some((key) => typeof input[key] !== "number" || !Number.isFinite(input[key]) || (input[key] as number) < 0)) return undefined;
  // Copy only schema fields: a newer core must not smuggle file paths or source text into the report.
  return Object.fromEntries([...counts, ...times].map((key) => [key, input[key]])) as unknown as TypeScriptProgramMetrics;
}

export interface ObservationGraph {
  nodes: number;
  edges: number;
  /** The graph's own confidence, before per-delta narrowing. */
  confidence: string;
  /** Confidence after reachability narrowing for this delta - the value that drove the verdict. */
  effectiveConfidence?: string;
  durationMs: number;
  phasesMs?: Record<string, number>;
  typescriptProgram?: TypeScriptProgramMetrics;
  adapterMetrics?: Record<string, { phasesMs: Record<string, number>; counts: Record<string, number> }>;
}

/**
 * The comparator. DiffCI's savings are only ever a difference against something, and the something is a
 * simple path-rule CI (src/planner/path-baseline.ts) - not "the whole suite". Phase 01 found that
 * comparator had been a strawman; carrying it in every report is what stops a later ledger quietly
 * dropping it.
 */
export interface ObservationBaseline {
  mode: "SELECTIVE" | "FULL";
  selectedTestCount: number;
  /**
   * The test files the path-rule comparator actually selected (2026-08-29, agent generation B).
   *
   * WHY THE COUNT WAS NOT ENOUGH. The comparator is the cheapest credible alternative to DiffCI, so the
   * question that decides whether DiffCI is worth paying for is not "did it run fewer tests than
   * everything" but "did running its choice, plus the analysis that produced it, cost less than running
   * the comparator's choice". Answering that requires EXECUTING the comparator's selection and measuring
   * it, and a count cannot be executed.
   *
   * These are the identities the comparator itself produced (`runPathBaseline().selectedTests`), carried
   * through unchanged and given exactly the same sorting and redaction as DiffCI's own `selectedTests`.
   * They are deliberately NOT reconstructed from `matchedRules`: reconstruction would insert an
   * interpretation layer between the comparator and the harness measuring it, which is the entire thing
   * this field exists to eliminate.
   *
   * INVARIANT: `selectedTests.length === selectedTestCount`. They are derived from one array at the
   * point of construction, so divergence is structurally impossible rather than merely unlikely - and
   * consumers still check, because a count and a list that disagree would silently mismeasure the
   * comparator arm of every economics experiment.
   */
  selectedTests: string[];
  matchedRules: string[];
}

export interface ObservationResult {
  mode: "SELECTIVE" | "FULL";
  changedFileCount: number;
  /** Repo-relative paths, replaced by digests when `payload.pathRedaction` is set. */
  changedFiles: string[];
  affectedSourceFileCount: number;
  selectedTests: string[];
  /** Every test file the engine could see. The denominator for any selection ratio. */
  totalTestCount: number;
  fallbackReasons: string[];
  /** The command DiffCI would have run. Present even in observe mode - it is the claim being tested. */
  proposedCommands: string[];
  /** Workspace execution can widen affected files to whole state-sharing suites. */
  workspaceCommands?: boolean;
  /** Explicit Go CI universe, when configured by the repository. */
  goScope?: "root-module";
  vueScope?: { packageRoot: string; testConfig: string };
  scopedTestFiles?: string[];
  /** Set when a selection was made but no runnable command could be built for it. */
  commandRefusalReason?: string;
  /** Selected paths no runner claimed. Non-empty means the command does not cover the selection. */
  unroutedTestPaths: string[];
  /**
   * True when the repository declares a test framework and the engine discovered no test files at all.
   * A blind spot forces FULL: an empty test universe must never read as "nothing to run" (Phase 01 F1).
   */
  blindSpot: boolean;
  riskSignals: Array<{ level: string; reason: string }>;
  graph: ObservationGraph;
  pathBaseline: ObservationBaseline;
  analysisStatus: string;
}

export interface ObservationReport {
  schema: typeof OBSERVATION_SCHEMA;
  producedAt: string;
  observer: {
    /** DiffCI's package version. */
    version: string;
    /** The exact DiffCI commit that produced this, when the observer's own checkout is a git repo. */
    engineSha?: string;
    node: string;
    platform: string;
  };
  repository: ObservationRepository;
  ci: ObservationCi;
  commitRange?: ObservationCommitRange;
  status: ObservationStatus;
  stage: ObservationStage;
  /** Present for REFUSED and ERROR. Written for a reader who has to decide whether to act. */
  reason?: string;
  result?: ObservationResult;
  economics?: import("./economics.js").EconomicsDecision;
  payload: ObservationPayloadDescription;
  nonInterference: NonInterferenceEvidence;
  timings: { totalMs: number; preObserveMs?: number; phasesMs?: Record<string, number> };
}

/**
 * Path redaction for repositories that will observe but will not send paths off their runner.
 *
 * A truncated SHA-256 is stable across runs and across repositories, which is exactly the trade being
 * made: the same file redacts to the same digest every time (so selection ratios and per-file trends
 * still work), and a holder of the digest can confirm a GUESSED path but cannot enumerate paths from
 * the digest alone. It is redaction, not anonymisation, and is described that way.
 */
export function redactPath(path: string, hash: (input: string) => string): string {
  return hash(path).slice(0, 12);
}

/**
 * Minimal structural validation, shared by the producer's own tests and (from Phase 03) by ingest.
 * Deliberately shallow: it checks that a document is the shape this version promises, not that its
 * numbers are true.
 */
export function validateObservationReport(
  value: unknown,
): { ok: true; report: ObservationReport } | { ok: false; error: string } {
  if (value === null || typeof value !== "object") return { ok: false, error: "report is not an object" };
  const record = value as Record<string, unknown>;
  if (record.schema !== OBSERVATION_SCHEMA) {
    return { ok: false, error: `unsupported schema ${String(record.schema)} (expected ${OBSERVATION_SCHEMA})` };
  }
  for (const field of ["producedAt", "status", "stage"] as const) {
    if (typeof record[field] !== "string") return { ok: false, error: `missing or non-string field "${field}"` };
  }
  if (!["OBSERVED", "REFUSED", "ERROR"].includes(record.status as string)) {
    return { ok: false, error: `unknown status ${String(record.status)}` };
  }
  if (record.payload === null || typeof record.payload !== "object") {
    return { ok: false, error: "missing payload description" };
  }
  const payload = record.payload as Record<string, unknown>;
  if (payload.includesFileContents !== false || payload.includesCredentials !== false) {
    return { ok: false, error: "payload claims to carry file contents or credentials, which this schema forbids" };
  }
  if (record.nonInterference === null || typeof record.nonInterference !== "object") {
    return { ok: false, error: "missing non-interference evidence" };
  }
  return { ok: true, report: value as ObservationReport };
}
