/**
 * A well-formed observation report, as the Phase 02 client actually emits one. Shared by the ingest
 * tests so that a change to the wire format breaks them in one place rather than in five.
 */
import { OBSERVATION_SCHEMA, type ObservationReport } from "../../src/client/report.js";

export function makeReport(overrides: Partial<ObservationReport> = {}): ObservationReport {
  return {
    schema: OBSERVATION_SCHEMA,
    producedAt: "2026-08-26T10:00:00.000Z",
    observer: { version: "0.1.0", engineSha: "f".repeat(40), node: "v22.5.0", platform: "linux" },
    repository: { provider: "github", ownerName: "orga/app", defaultBranch: "main", providerRepositoryId: "111" },
    ci: {
      provider: "github-actions",
      runId: "9001",
      runAttempt: "1",
      workflow: "DiffCI (observation only)",
      job: "diffci",
      event: "pull_request",
      ref: "refs/pull/7/merge",
    },
    commitRange: { baseSha: "a".repeat(40), headSha: "b".repeat(40), source: "pull-request-event" },
    status: "OBSERVED",
    stage: "complete",
    result: {
      mode: "SELECTIVE",
      changedFileCount: 1,
      changedFiles: ["src/alpha.ts"],
      affectedSourceFileCount: 1,
      selectedTests: ["test/alpha.test.ts"],
      totalTestCount: 12,
      fallbackReasons: [],
      proposedCommands: ["npx --no-install vitest run test/alpha.test.ts"],
      unroutedTestPaths: [],
      blindSpot: false,
      riskSignals: [],
      graph: { nodes: 40, edges: 60, confidence: "COMPLETE", effectiveConfidence: "COMPLETE", durationMs: 900 },
      pathBaseline: { mode: "FULL", selectedTestCount: 12, selectedTests: Array.from({ length: 12 }, (_u, i) => `baseline/t${i}.test.ts`), matchedRules: ["config/dependency -> full fallback"] },
      analysisStatus: "SAFE_TO_PROPOSE",
    },
    payload: {
      includesFilePaths: true,
      includesFileContents: false,
      includesEnvironment: false,
      includesCredentials: false,
    },
    nonInterference: {
      headShaBefore: "b".repeat(40),
      headShaAfter: "b".repeat(40),
      worktreeDigestBefore: "d1",
      worktreeDigestAfter: "d1",
      worktreeUnchanged: true,
      reportWrittenOutsideRepository: true,
      workflowFindings: [],
    },
    timings: { totalMs: 2100 },
    ...overrides,
  };
}
