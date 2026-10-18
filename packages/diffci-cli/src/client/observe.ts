/**
 * The client-side observation run (Phase 02, 2026-08-26).
 *
 * This is the whole product, executed on someone else's runner: resolve a commit range, build the real
 * dependency graph from the checkout that is already there, work out which tests DiffCI would have run,
 * work out what a simple path-rule CI would have run, and write a report. It runs nothing, changes
 * nothing, and cancels nothing.
 *
 * Two properties are load-bearing, and both are enforced here rather than promised:
 *
 * READ-ONLY CHECKOUT. Analysis does not modify source; Go metadata can populate tool caches outside
 * the checkout, with module edits and downloads disabled. This
 * function additionally records HEAD and `git status --porcelain` before and after itself, so a run that
 * DID dirty the tree says so in its own report instead of being discovered weeks later.
 *
 * NEVER THROWS. A crash inside an observer that a repository installed on trust must not take their CI
 * step down with it, and must not be silent either. Every failure becomes a report with status ERROR or
 * REFUSED and the stage it happened at. The distinction is deliberate and is preserved everywhere:
 * REFUSED is a limit DiffCI is stating (no TypeScript project, base commit not fetched), ERROR is a
 * defect in DiffCI. Counting them together would let a week of crashes read as a week of honest limits.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

import { economicsContext, evaluateEconomics, type EconomicsDecision } from "./economics.js";
import {
  readCiEnvironment,
  resolveCommitRange,
  type GitRunner,
  type ObservationEnvironment,
  type ResolvedCommitRange,
} from "./context.js";
import {
  OBSERVATION_SCHEMA,
  readTypeScriptProgramMetrics,
  redactPath,
  type NonInterferenceEvidence,
  type ObservationReport,
  type ObservationStage,
  type ObservationStatus,
} from "./report.js";
import { auditWorkflows } from "./workflow-guard.js";

/** Build output and dependencies are never sources of truth about a repository's own structure. */
const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build"];

export interface ObserveOptions {
  /** The checked-out repository to observe. Never written to. */
  repoPath: string;
  env: ObservationEnvironment;
  /** DiffCI's own version string, recorded in the report. */
  version: string;
  /** The DiffCI commit that produced this report, when it can be determined. */
  engineSha?: string;
  baseOverride?: string;
  headOverride?: string;
  /** Replace every path in the report with a stable 12-character digest. */
  redactPaths?: boolean;
  /** Where the report will be written, so the report can state whether that is inside the checkout. */
  reportPath?: string;
  /** Injected for tests. Defaults to a real git in `repoPath`. */
  git?: GitRunner;
  /** Optional external CI timing history. It can only bypass to full validation. */
  economicsHistory?: unknown;
  economicsJobKey?: string;
  forceAnalysis?: boolean;
  /** Optional cache outside the checkout; graph resolution and selection remain fresh. */
  vueAnalysisCacheDir?: string;
}

function makeGitRunner(repoPath: string): GitRunner {
  return (args) => {
    try {
      const stdout = execFileSync("git", args, {
        cwd: repoPath,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, stdout };
    } catch (error) {
      return { ok: false, error: (error as Error).message.split("\n")[0] ?? "git failed" };
    }
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A digest rather than the porcelain text itself: the point is only whether it changed. */
function worktreeDigest(git: GitRunner): string | undefined {
  const result = git(["status", "--porcelain"]);
  return result.ok ? sha256(result.stdout) : undefined;
}

function headSha(git: GitRunner): string | undefined {
  const result = git(["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

/**
 * True when the report would land inside the observed checkout. That is not a style preference: an
 * untracked file in the working tree changes `git status`, and CI jobs that assert a clean tree (a
 * generated-code check, a lockfile check, `git diff --exit-code`) would start failing because DiffCI
 * was installed. The report is written outside the repository by default for exactly that reason.
 */
export function isInsideRepository(repoPath: string, candidate: string): boolean {
  const rel = relative(resolve(repoPath), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel);
}

export async function observe(options: ObserveOptions): Promise<ObservationReport> {
  const startedAt = Date.now();
  const preObserveMs = Math.round(process.uptime() * 1000);
  const phasesMs: Record<string, number> = {};
  let phaseStart = performance.now();
  const markPhase = (name: string) => { const now = performance.now(); phasesMs[name] = Math.round(now - phaseStart); phaseStart = now; };
  const repoPath = resolve(options.repoPath);
  const git = options.git ?? makeGitRunner(repoPath);
  const ci = readCiEnvironment(options.env);
  const [owner, name] = (ci.ownerName ?? "").split("/");

  const before = { head: headSha(git), worktree: worktreeDigest(git) };
  const hashPath = (path: string): string => (options.redactPaths ? redactPath(path, sha256) : path);

  // Declared before `finish` closes over it: the range is part of every report, including the reports
  // produced by failures that happen after it was resolved.
  let range: ResolvedCommitRange | undefined;
  let economics: EconomicsDecision | undefined;

  const finish = (
    status: ObservationStatus,
    stage: ObservationStage,
    extra: { reason?: string; result?: ObservationReport["result"] },
  ): ObservationReport => {
    const after = { head: headSha(git), worktree: worktreeDigest(git) };
    const nonInterference: NonInterferenceEvidence = {
      headShaBefore: before.head,
      headShaAfter: after.head,
      worktreeDigestBefore: before.worktree,
      worktreeDigestAfter: after.worktree,
      worktreeUnchanged:
        before.head !== undefined &&
        before.worktree !== undefined &&
        before.head === after.head &&
        before.worktree === after.worktree,
      reportWrittenOutsideRepository:
        options.reportPath === undefined ? true : !isInsideRepository(repoPath, options.reportPath),
      workflowFindings: safeAuditWorkflows(repoPath),
    };
    markPhase("finalization");
    return {
      schema: OBSERVATION_SCHEMA,
      producedAt: new Date().toISOString(),
      observer: {
        version: options.version,
        engineSha: options.engineSha,
        node: process.version,
        platform: process.platform,
      },
      repository: {
        provider: ci.provider === "github-actions" ? "github" : "unknown",
        ownerName: owner && name ? `${owner}/${name}` : undefined,
        defaultBranch: ci.defaultBranch,
        providerRepositoryId: ci.providerRepositoryId,
      },
      ci: {
        provider: ci.provider,
        runId: ci.runId,
        runAttempt: ci.runAttempt,
        workflow: ci.workflow,
        job: ci.job,
        event: ci.event,
        ref: ci.ref,
        syntheticTrigger: ci.syntheticTrigger,
      },
      commitRange: range ? { ...range } : undefined,
      status,
      stage,
      reason: extra.reason,
      result: extra.result,
      economics,
      payload: {
        includesFilePaths: options.redactPaths !== true,
        includesFileContents: false,
        includesEnvironment: false,
        includesCredentials: false,
        pathRedaction: options.redactPaths ? "sha256-12" : undefined,
      },
      nonInterference,
      timings: { totalMs: Date.now() - startedAt, preObserveMs, phasesMs },
    };
  };

  try {
    const resolved = resolveCommitRange({
      env: options.env,
      git,
      baseOverride: options.baseOverride,
      headOverride: options.headOverride,
    });
    if (!resolved.ok) return finish("REFUSED", "context", { reason: resolved.reason });
    range = resolved.range;
    markPhase("context");

    if (options.economicsJobKey || options.economicsHistory) {
      const remote = git(["remote", "get-url", "origin"]);
      const repository = remote.ok ? /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(remote.stdout.trim())?.[1] : undefined;
      economics = evaluateEconomics(options.economicsHistory, { repository, jobKey: options.economicsJobKey, contextKey: economicsContext(repoPath), observerVersion: options.version });
      if (economics.decision === "BYPASS_FULL") {
        const samples = (options.economicsHistory as { samples: { headSha: string }[] }).samples;
        if (options.forceAnalysis || samples.some(sample => !git(["merge-base", "--is-ancestor", sample.headSha, range!.baseSha]).ok)) economics = { ...economics, decision: "ANALYZE", reason: "Forced resampling or history is not ancestral to this change" };
      }
      markPhase("economics");
      if (economics.decision === "BYPASS_FULL") return finish("REFUSED", "eligibility", { reason: `ECONOMICS_FULL_BYPASS: ${economics.reason}. No selective command is authorized.` });
    }

    const [{ analyzeGitDelta }, { classifyRepositoryProject, buildDependencyGraph }, { ImpactAnalyzer }, { runPathBaseline }, { commandSpecToString, planSelectiveTestCommands }] = await Promise.all([
      import("@diffci.com/core/git/git-diff"), import("@diffci.com/core/repo/graph"), import("@diffci.com/core/repo/impact"), import("@diffci.com/core/planner/path-baseline"), import("@diffci.com/core/planner/test-command"),
    ]);
    markPhase("engineLoad");

    // The eligibility gate is asked of the graph builder itself (classifyRepositoryProject), not of a
    // separate list of conditions that can drift away from it. Phase 01 F3 is what that drift costs.
    const capability = classifyRepositoryProject(repoPath);
    markPhase("eligibility");
    if (!capability.capable) {
      return finish("REFUSED", "eligibility", {
        reason: `DiffCI supports TypeScript/JavaScript projects, Vue components, root Go modules, and conventional Maven reactors: ${capability.reason}`,
      });
    }

    const deltaResult = await analyzeGitDelta({ baseSha: range.baseSha, headSha: range.headSha, repoPath });
    if (!deltaResult.success) {
      return finish("REFUSED", "delta", { reason: deltaResult.error });
    }
    const delta = deltaResult.delta;
    markPhase("delta");

    const graphResult = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS, vueAnalysisCache: options.vueAnalysisCacheDir ? { directory: options.vueAnalysisCacheDir, version: `${options.version}:${options.engineSha ?? ""}` } : undefined });
    markPhase("graph");
    if (graphResult.graph.nodes.length === 0) {
      return finish("REFUSED", "graph", {
        reason:
          "the dependency graph came back empty - DiffCI will not propose a selection from a graph that sees none of this repository" +
          (graphResult.adapterBlockers?.length ? `; ${graphResult.adapterBlockers.join("; ")}` : ""),
      });
    }
    const profile = graphResult.profile;

    const impact = new ImpactAnalyzer().analyze(delta, graphResult, profile, {
      repositoryFiles: deltaResult.inventory?.files,
    });

    const baseline = runPathBaseline(profile.testFilePaths, delta.files, profile);

    const selectedTests = impact.affectedTests.map((test) => test.path).sort();
    // The comparator's own identities, sorted and redacted identically so the two arms of an economics
    // experiment are executed the same way rather than merely counted the same way.
    const comparatorSelectedTests = [...baseline.selectedTests].sort().map(hashPath);
    const commandPlan = impact.fallbackRequired
      ? undefined
      : planSelectiveTestCommands(profile, selectedTests);

    markPhase("impactAndCommands");
    return finish("OBSERVED", "complete", {
      result: {
        mode: impact.fallbackRequired ? "FULL" : "SELECTIVE",
        changedFileCount: delta.files.length,
        changedFiles: delta.files.map((file) => hashPath(file.path)),
        affectedSourceFileCount: impact.affectedSourceFiles.length,
        selectedTests: selectedTests.map(hashPath),
        totalTestCount: profile.testFilePaths.length,
        fallbackReasons: impact.fallbackReasons,
        proposedCommands: (commandPlan?.commands ?? []).map(commandSpecToString),
        workspaceCommands: Boolean(profile.workspaceTestPackages?.length),
        goScope: profile.diffciConfig?.go?.scope,
        vueScope: profile.vueScope ? { packageRoot: hashPath(profile.vueScope.packageRoot), testConfig: hashPath(profile.vueScope.testConfig) } : undefined,
        scopedTestFiles: profile.vueScope ? profile.testFilePaths.map(hashPath) : undefined,
        commandRefusalReason: commandPlan?.refusalReason,
        unroutedTestPaths: (commandPlan?.unroutedPaths ?? []).map(hashPath),
        blindSpot: profile.testUniverse?.blindSpot === true,
        riskSignals: impact.riskSignals.map((signal) => ({ level: signal.level, reason: signal.reason })),
        graph: {
          nodes: graphResult.graph.nodes.length,
          edges: graphResult.graph.edges.length,
          confidence: graphResult.confidence,
          effectiveConfidence: impact.effectiveGraphConfidence,
          durationMs: Math.round(graphResult.performance.durationMs),
          phasesMs: graphResult.performance.phasesMs,
          typescriptProgram: readTypeScriptProgramMetrics((graphResult.performance as unknown as Record<string, unknown>).typescriptProgram),
          adapterMetrics: graphResult.performance.adapterMetrics,
        },
        pathBaseline: {
          mode: baseline.fallbackRequired ? "FULL" : "SELECTIVE",
          // Count and list derived from ONE array, so they cannot disagree. Sorted and redacted exactly
          // like DiffCI's own `selectedTests` above, so a harness can execute either arm identically.
          selectedTestCount: comparatorSelectedTests.length,
          selectedTests: comparatorSelectedTests,
          matchedRules: baseline.matchedRules,
        },
        analysisStatus: impact.analysisStatus,
      },
    });
  } catch (error) {
    return finish("ERROR", "complete", {
      reason: `${(error as Error).name}: ${(error as Error).message.split("\n")[0]}`,
    });
  }
}

/**
 * The workflow audit runs on every observation so the byte-identical claim is re-checked continuously,
 * not once at install. It is best-effort: a repository whose workflows cannot be read still gets its
 * observation, with the audit absent rather than the run lost.
 */
function safeAuditWorkflows(repoPath: string): NonInterferenceEvidence["workflowFindings"] {
  try {
    return auditWorkflows(repoPath).findings;
  } catch {
    return [];
  }
}
