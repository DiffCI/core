/**
 * Enforce mode, Level 1 (docs/enforce-mode-01-plan.md, step 1).
 *
 * Shadow mode only predicts. Enforce mode lets `diffci verify` run the selected tests INSTEAD of the
 * full suite - so every way the selection could be wrong has to be answered here with "run FULL", never
 * with "run less". The checks are ordered: repository-level conditions first (is enforcement on at all,
 * approved, not demoted), then per-run conditions (is this range and this analysis trustworthy). The
 * first one that fires is recorded in the receipt; nothing after it is evaluated.
 *
 * `evaluateEnforcement` is pure. Everything that touches git, the event payload or the environment is
 * in `collectEnforcementContext`, so each fallback can be tested without a repository.
 */
import { extname } from "node:path";

import { readEventPayload, type GitRunner } from "./context.js";
import type { ObservationCommitRange, ObservationReport } from "./report.js";

/** The only policy shape this CLI understands. A newer or older `enforce` block falls back to FULL. */
export const ENFORCE_POLICY_VERSION = 1;
export const FORCE_FULL_LABEL = "diffci:force-full";
export const ENFORCE_VARIABLE = "DIFFCI_ENFORCE";

export type EnforcementFallback =
  | "kill-switch"
  | "per-run-override"
  | "policy-not-approved"
  | "open-unsafe-miss"
  | "untrusted-range"
  | "analysis-failure"
  | "graph-confidence"
  | "global-risk"
  | "empty-selection";

export interface EnforcementContext {
  /** Value of DIFFCI_ENFORCE. Anything but "on" keeps enforcement off. */
  killSwitch: string | undefined;
  pullRequestLabels: string[];
  headCommitMessage: string | undefined;
  /** The raw `enforce` block of diffci.config.json, read at the range BASE so a change cannot approve itself. */
  policy: unknown;
  range: { trusted: true } | { trusted: false; reason: string };
  pathsRedacted: boolean;
}

export interface EnforcementDecision {
  policy: "enforce";
  policy_version: typeof ENFORCE_POLICY_VERSION;
  /** null when every check passed and the selected tests may replace the full suite. */
  fired_fallback: EnforcementFallback | null;
  detail: string;
}

/**
 * Paths whose change can affect every test without appearing in the import graph. The analyzer already
 * falls back for many of these; enforce mode lists them again because here a gap costs a missed failure,
 * not a mis-scored prediction.
 */
const GLOBAL_RISK_PATTERNS: readonly RegExp[] = [
  /^\.github\//,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?)$/,
  /(?:^|\/)\.(?:npmrc|nvmrc|node-version|tool-versions)$/,
  /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/,
  /(?:^|\/)(?:jest|vitest|vite|playwright|cypress|mocha|ava|karma|babel)\.config\.[^/]+$/,
  /(?:^|\/)\.(?:mocharc|babelrc)(?:\.[^/]+)?$/,
  /(?:^|\/)diffci(?:\.config)?\.json$/,
];

const DOC_DIRECTORIES: readonly string[] = ["docs", "doc", "documentation"];

/** Same rule as RepositoryLayout.isDocumentationPath, without needing a repository profile. */
function isDocumentationPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".mdx") return true;
  const first = path.split("/")[0];
  return first !== undefined && DOC_DIRECTORIES.includes(first.toLowerCase());
}

function policyProblem(policy: unknown): string | undefined {
  if (policy === undefined) return "diffci.config.json at the range base has no `enforce` block";
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return "`enforce` must be an object";
  const block = policy as Record<string, unknown>;
  if (block.policyVersion !== ENFORCE_POLICY_VERSION) {
    return `enforce.policyVersion is ${JSON.stringify(block.policyVersion)}; this DiffCI supports ${ENFORCE_POLICY_VERSION}`;
  }
  if (block.level !== 1) return `enforce.level is ${JSON.stringify(block.level)}; only level 1 is implemented`;
  if (typeof block.approvedBy !== "string" || block.approvedBy.trim() === "") return "enforce.approvedBy is missing";
  if (typeof block.approvedAt !== "string" || Number.isNaN(Date.parse(block.approvedAt))) return "enforce.approvedAt is not a date";
  if (block.openUnsafeMisses !== undefined && !Array.isArray(block.openUnsafeMisses)) return "enforce.openUnsafeMisses must be an array";
  return undefined;
}

function openMisses(policy: unknown): unknown[] {
  const misses = (policy as Record<string, unknown>).openUnsafeMisses;
  return Array.isArray(misses) ? misses : [];
}

/** Matches a `DiffCI: full` trailer line anywhere in the head commit message. */
export function hasForceFullTrailer(message: string | undefined): boolean {
  return message !== undefined && /^diffci:\s*full\s*$/im.test(message);
}

export function evaluateEnforcement(context: EnforcementContext, observation: ObservationReport): EnforcementDecision {
  const decide = (fired: EnforcementFallback | null, detail: string): EnforcementDecision => ({
    policy: "enforce",
    policy_version: ENFORCE_POLICY_VERSION,
    fired_fallback: fired,
    detail,
  });

  if (context.killSwitch !== "on") return decide("kill-switch", `${ENFORCE_VARIABLE} is not "on"`);
  if (context.pullRequestLabels.includes(FORCE_FULL_LABEL)) return decide("per-run-override", `pull request is labelled ${FORCE_FULL_LABEL}`);
  if (hasForceFullTrailer(context.headCommitMessage)) return decide("per-run-override", "head commit carries a `DiffCI: full` trailer");
  const problem = policyProblem(context.policy);
  if (problem) return decide("policy-not-approved", problem);
  const misses = openMisses(context.policy);
  if (misses.length > 0) return decide("open-unsafe-miss", `${misses.length} unsafe miss(es) recorded and not yet cleared`);
  if (!context.range.trusted) return decide("untrusted-range", context.range.reason);

  const result = observation.result;
  if (observation.status !== "OBSERVED" || !result) {
    return decide("analysis-failure", observation.reason ?? `analysis status ${observation.status}`);
  }

  const confidence = result.graph.effectiveConfidence ?? result.graph.confidence;
  if (confidence !== "COMPLETE") return decide("graph-confidence", `effective graph confidence is ${confidence}, not COMPLETE`);

  if (context.pathsRedacted) return decide("global-risk", "changed paths are redacted, so global-risk paths cannot be checked");
  const critical = result.riskSignals.find((signal) => signal.level === "critical");
  if (critical) return decide("global-risk", `critical risk signal: ${critical.reason}`);
  if (result.mode === "FULL") return decide("global-risk", `analyzer required full validation: ${result.fallbackReasons[0] ?? "no reason given"}`);
  const risky = result.changedFiles.find((path) => GLOBAL_RISK_PATTERNS.some((pattern) => pattern.test(path)));
  if (risky) return decide("global-risk", `global-risk path changed: ${risky}`);

  if (result.selectedTests.length === 0 && result.changedFiles.some((path) => !isDocumentationPath(path))) {
    return decide("empty-selection", "source files changed but no tests were selected");
  }

  return decide(null, "every enforce check passed");
}

function git(runner: GitRunner, args: string[]): string | undefined {
  const result = runner(args);
  return result.ok ? result.stdout : undefined;
}

function rangeTrust(runner: GitRunner, range: ObservationCommitRange | undefined): EnforcementContext["range"] {
  if (!range) return { trusted: false, reason: "no commit range was resolved" };
  // A head-parent range covers one commit, not the whole push or branch it stands in for.
  if (range.source === "head-parent") return { trusted: false, reason: "range is the head commit's parent, not the full push" };
  if (git(runner, ["rev-parse", "--is-shallow-repository"])?.trim() !== "false") {
    return { trusted: false, reason: "checkout is shallow; use fetch-depth: 0" };
  }
  // Force-pushes leave `before` off the new history; a diff from it is not "what this push changed".
  if (git(runner, ["merge-base", "--is-ancestor", range.baseSha, range.headSha]) === undefined) {
    return { trusted: false, reason: `base ${range.baseSha.slice(0, 12)} is not an ancestor of head ${range.headSha.slice(0, 12)}` };
  }
  return { trusted: true };
}

function policyAtBase(runner: GitRunner, range: ObservationCommitRange | undefined): unknown {
  if (!range) return undefined;
  const text = git(runner, ["show", `${range.baseSha}:diffci.config.json`]);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).enforce : undefined;
  } catch {
    return undefined;
  }
}

function pullRequestLabels(env: Record<string, string | undefined>): string[] {
  const payload = readEventPayload(env);
  const pullRequest = payload?.pull_request;
  if (pullRequest === null || typeof pullRequest !== "object") return [];
  const labels = (pullRequest as Record<string, unknown>).labels;
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => {
    const name = label !== null && typeof label === "object" ? (label as Record<string, unknown>).name : undefined;
    return typeof name === "string" ? [name] : [];
  });
}

export function collectEnforcementContext(
  runner: GitRunner,
  env: Record<string, string | undefined>,
  observation: ObservationReport,
): EnforcementContext {
  const range = observation.commitRange;
  return {
    killSwitch: env[ENFORCE_VARIABLE],
    pullRequestLabels: pullRequestLabels(env),
    headCommitMessage: range ? git(runner, ["log", "-1", "--format=%B", range.headSha]) : undefined,
    policy: policyAtBase(runner, range),
    range: rangeTrust(runner, range),
    pathsRedacted: observation.payload.pathRedaction !== undefined,
  };
}
