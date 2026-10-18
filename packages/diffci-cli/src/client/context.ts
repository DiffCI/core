/**
 * Where am I, and which two commits am I being asked about? (Phase 02, 2026-08-26.)
 *
 * Running inside someone else's CI means the commit range is not a parameter a human chose - it has to
 * be recovered from the environment, and the environment lies in specific, well-known ways:
 *
 *   - `actions/checkout` defaults to `fetch-depth: 1`. The base commit of a pull request is then simply
 *     absent from the local object store, and `git diff base..head` fails with a message about a bad
 *     revision that reads, to anyone who has not seen it before, like a DiffCI bug.
 *   - On a pull request, the checked-out HEAD is a MERGE commit GitHub created, not the head of the
 *     contributor's branch. Diffing HEAD^..HEAD there compares against the base branch tip, which is a
 *     different question from "what did this pull request change".
 *   - On the first push to a new branch, `event.before` is forty zeros. Treating that as a commit SHA
 *     produces an empty diff, and an empty diff reads downstream as "nothing changed, skip everything".
 *
 * Every one of those has the same shape: a plausible-looking range that answers the wrong question. So
 * this module resolves a range only when it can name where both ends came from and verify both exist
 * locally, and otherwise REFUSES with a reason that says what to change. It never falls back to a range
 * it had to guess.
 */
import { existsSync, readFileSync } from "node:fs";

/** Injected so tests can drive this without a real repository. Returns stdout, or a failure. */
export type GitRunner = (args: string[]) => { ok: true; stdout: string } | { ok: false; error: string };

export interface ObservationEnvironment {
  [key: string]: string | undefined;
}

export interface CiEnvironmentFacts {
  provider: "github-actions" | "local" | "unknown";
  ownerName?: string;
  providerRepositoryId?: string;
  defaultBranch?: string;
  runId?: string;
  runAttempt?: string;
  workflow?: string;
  job?: string;
  event?: string;
  ref?: string;
  syntheticTrigger?: boolean;
}

/** Triggers that carry no inherent "what changed" - a range for these would have to be invented. */
const SYNTHETIC_TRIGGERS = new Set(["schedule", "workflow_dispatch", "repository_dispatch", "release"]);

const ZERO_SHA = "0000000000000000000000000000000000000000";

function readEventPayload(env: ObservationEnvironment): Record<string, unknown> | undefined {
  const path = env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // A malformed event payload is the runner's problem, not ours. Callers degrade to the flat
    // GITHUB_* variables, which is strictly less information but never wrong information.
    return undefined;
  }
}

function nested(record: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function readCiEnvironment(env: ObservationEnvironment): CiEnvironmentFacts {
  if (env.GITHUB_ACTIONS !== "true") {
    return { provider: env.CI === "true" ? "unknown" : "local" };
  }
  const payload = readEventPayload(env);
  const event = asString(env.GITHUB_EVENT_NAME);
  return {
    provider: "github-actions",
    ownerName: asString(env.GITHUB_REPOSITORY),
    providerRepositoryId: asString(env.GITHUB_REPOSITORY_ID),
    defaultBranch:
      asString(nested(payload, "repository", "default_branch")) ?? asString(env.GITHUB_DEFAULT_BRANCH),
    runId: asString(env.GITHUB_RUN_ID),
    runAttempt: asString(env.GITHUB_RUN_ATTEMPT),
    workflow: asString(env.GITHUB_WORKFLOW),
    job: asString(env.GITHUB_JOB),
    event,
    ref: asString(env.GITHUB_REF),
    syntheticTrigger: event !== undefined && SYNTHETIC_TRIGGERS.has(event),
  };
}

export interface ResolvedCommitRange {
  baseSha: string;
  headSha: string;
  source: "explicit-flags" | "pull-request-event" | "push-event" | "head-parent";
  mergeBaseSha?: string;
}

export type CommitRangeResolution =
  | { ok: true; range: ResolvedCommitRange }
  | { ok: false; reason: string };

export interface ResolveCommitRangeOptions {
  env: ObservationEnvironment;
  git: GitRunner;
  /** --base / --head. When either is given, both must be, and neither is second-guessed. */
  baseOverride?: string;
  headOverride?: string;
}

function commitExists(git: GitRunner, sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  return git(["cat-file", "-e", `${sha}^{commit}`]).ok;
}

/**
 * `--verify <rev>^{commit}` rather than a bare `rev-parse`: a bare rev-parse hands back any
 * well-formed 40-character hex string unchanged, whether or not that commit exists in this clone. A
 * `--base` naming a commit the shallow checkout does not have would then sail through here and fail
 * three stages later, as a delta error, which reads like a DiffCI defect rather than a missing fetch.
 */
function resolveSha(git: GitRunner, rev: string): string | undefined {
  const result = git(["rev-parse", "--verify", `${rev}^{commit}`]);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

function mergeBase(git: GitRunner, a: string, b: string): string | undefined {
  const result = git(["merge-base", a, b]);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

/** The one sentence every "commit missing locally" refusal ends with, so the fix is never a guess. */
const DEEPEN_HINT =
  "the commit is not in this checkout - add `fetch-depth: 0` to the actions/checkout step in the job that runs DiffCI (this does not affect any other job)";

export function resolveCommitRange(options: ResolveCommitRangeOptions): CommitRangeResolution {
  const { env, git, baseOverride, headOverride } = options;

  if (baseOverride !== undefined || headOverride !== undefined) {
    if (baseOverride === undefined || headOverride === undefined) {
      return { ok: false, reason: "--base and --head must be given together" };
    }
    const base = resolveSha(git, baseOverride);
    const head = resolveSha(git, headOverride);
    if (!base) return { ok: false, reason: `base revision ${baseOverride} could not be resolved: ${DEEPEN_HINT}` };
    if (!head) return { ok: false, reason: `head revision ${headOverride} could not be resolved: ${DEEPEN_HINT}` };
    return { ok: true, range: { baseSha: base, headSha: head, source: "explicit-flags" } };
  }

  const payload = readEventPayload(env);
  const event = env.GITHUB_EVENT_NAME;

  if (event === "pull_request" || event === "pull_request_target") {
    const headSha = asString(nested(payload, "pull_request", "head", "sha"));
    const baseSha = asString(nested(payload, "pull_request", "base", "sha"));
    if (!headSha || !baseSha) {
      return { ok: false, reason: "pull_request event payload carried no head/base SHA" };
    }
    if (!commitExists(git, headSha)) {
      return {
        ok: false,
        reason: `pull request head ${headSha.slice(0, 12)} is not present locally: ${DEEPEN_HINT}`,
      };
    }
    if (!commitExists(git, baseSha)) {
      return {
        ok: false,
        reason: `pull request base ${baseSha.slice(0, 12)} is not present locally: ${DEEPEN_HINT}`,
      };
    }
    // GitHub's base.sha is the base branch tip as of the event. When the branch has moved on since,
    // diffing from it attributes other people's commits to this pull request, so the merge base is
    // used when git can compute one - and the fact that it was used is recorded, not hidden.
    const common = mergeBase(git, baseSha, headSha);
    const effectiveBase = common ?? baseSha;
    return {
      ok: true,
      range: {
        baseSha: effectiveBase,
        headSha,
        source: "pull-request-event",
        mergeBaseSha: common && common !== baseSha ? common : undefined,
      },
    };
  }

  if (event === "push") {
    const headSha = asString(env.GITHUB_SHA) ?? resolveSha(git, "HEAD");
    if (!headSha) return { ok: false, reason: "could not determine the head commit of this push" };
    const before = asString(nested(payload, "before"));
    if (before && before !== ZERO_SHA && commitExists(git, before)) {
      return { ok: true, range: { baseSha: before, headSha, source: "push-event" } };
    }
    // A branch's first push has no `before`. The head's own parent is the honest substitute and is
    // labelled as such - it answers "what did this commit change", not "what did this push change".
    const parent = resolveSha(git, `${headSha}^`);
    if (!parent) {
      return {
        ok: false,
        reason:
          before === ZERO_SHA
            ? `this push created the branch and its head commit has no parent in this checkout: ${DEEPEN_HINT}`
            : `no usable base commit for this push: ${DEEPEN_HINT}`,
      };
    }
    return { ok: true, range: { baseSha: parent, headSha, source: "head-parent" } };
  }

  const head = resolveSha(git, "HEAD");
  if (!head) return { ok: false, reason: "not a git repository, or HEAD could not be resolved" };
  const parent = resolveSha(git, "HEAD^");
  if (!parent) {
    return {
      ok: false,
      reason: `HEAD has no parent commit in this checkout, so there is no range to analyse: ${DEEPEN_HINT}`,
    };
  }
  return { ok: true, range: { baseSha: parent, headSha: head, source: "head-parent" } };
}
