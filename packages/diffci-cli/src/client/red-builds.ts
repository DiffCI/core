/**
 * `diffci red-builds <owner/repo>`: how many of a repository's red pull request builds failed on checks the
 * author (or their coding agent) could have run before pushing.
 *
 * It reads CI history only, through GitHub's REST API, and runs nothing. For the most recent pull request
 * workflow runs it fetches the job list of every red run, the failure annotations of each failing check job,
 * and, for the runs it judges preventable, the head commit message (to spot agent co-author trailers).
 *
 * How a red run is judged (method of the Sentry and Paperclip studies, 2026-11-11):
 * - Each failing job is `infra` (only setup/install/cache steps failed, or no step failed: cancelled or
 *   timed out), `ci-only` (E2E, browser, deploy, release, lockfile and similar jobs no local check runs),
 *   or `check` (lint, format, typecheck, build, unit and integration tests). Names that match neither count
 *   as ci-only, so an unknown job can never inflate the preventable count.
 * - A failing check job is the PR's `own` failure when none of its annotation signatures (file + first
 *   message line, numbers and hashes blurred) also failed on a different PR in the window. A signature seen
 *   on several PRs is `shared`: a broken base branch or a test that fails for everyone, not this change.
 * - preventable: every failing job is an own check failure. partly: an own check failure next to other
 *   failures. likely: check failures with no annotations to confirm whose they are. flaky: the same head
 *   commit later passed in the same workflow.
 *
 * Every figure is an upper bound: it assumes the author ran the check and that it included the failing
 * test. Pacing follows DiffCI's outreach rules: authenticated, one call at a time, at least 1.2 s apart,
 * stop on Retry-After or when fewer than 1,000 calls remain in the hour.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const RED_BUILDS_SCHEMA = 1;

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

const INFRA_STEP = /set up|setup|checkout|install|cache|download|upload|restore|docker|login|post /i;
/** Jobs no local check can stand in for, whatever else the name says ("e2e tests" is not a unit test). */
const CI_ONLY_STRONG = /\b(e2e|end[- ]to[- ]end|playwright|cypress|puppeteer|selenium|browserstack|deploy(ment)?|preview|docker|lighthouse|chromatic|percy|visual)\b/i;
/** CI-side jobs that lose to a check word: "Typecheck + Release Registry" is still a typecheck. */
const CI_ONLY_JOB = /\b(release|publish|image|container|bench(mark)?s?|perf(ormance)?|size[- ]?(limit|check)?|bundle[- ]?size|codeql|security|snyk|dependency[- ]review|licen[cs]e|label(er)?|stale|triage|storybook|cla|dco|semantic|pr[- ]title|changeset|lockfile|danger|codecov|coverage[- ]upload|vercel|netlify|sonar)\b/i;
const CHECK_JOB = /\b(lint(ing)?|eslint|biome|prettier|format(ting)?|fmt|style|typecheck|type[- ]?check(ing)?|types|tsc|mypy|pyright|clippy|vet|build|compile|unit|tests?|suites?|vitest|jest|mocha|pytest|spec|integration|check)\b/i;
/** Aggregate gate jobs ("all required jobs passed"): they fail because another job did, so they are ignored
 * whenever another job in the same run failed too. */
const AGGREGATE_JOB = /^(verify|gate|ci|required|all[- ]?(required|checks|jobs|green)?([- ]?(passed|pass|green|ok))?|ci[- ]?(ok|success|passed|status|result)|status|summary|results?|conclusion|done|complete|finish(ed)?|success|alls-green|check[- ]results?)$/i;
const CI_ONLY_STEP = /lockfile|lock file|migration ordering/i;
const GENERIC_ANNOTATION = /process completed with exit code|^command failed|elifecycle|exited with code/i;
const TIMEOUT = /timed out|timeout/i;
const AGENT_TRAILER = /co-authored-by:[^\n]*?\b(claude|cursor|copilot|codex|devin|openai|anthropic|jules|aider|windsurf)\b|generated with \[?(claude code|codex)/i;
const AGENT_BRANCH = /^(claude|codex|copilot|cursor|devin|jules)[/-]/i;

export type JobBucket = "infra" | "ci-only" | "check";
export type Verdict = "preventable" | "partly" | "likely" | "shared" | "ci-only" | "flaky" | "infra";
export const VERDICTS: readonly Verdict[] = ["preventable", "partly", "likely", "shared", "ci-only", "flaky", "infra"];

export interface RunSummary {
  id: number;
  workflowId: number;
  workflowName: string;
  attempt: number;
  headSha: string;
  headBranch: string;
  headRepo: string;
  conclusion: string | null;
  createdAt: string;
}

export interface JobSummary {
  id: number;
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedSteps: string[];
}

export interface Annotation {
  path: string | null;
  title: string | null;
  message: string | null;
  level: string | null;
}

export interface Patterns {
  checkJob: RegExp;
  ciOnlyJob: RegExp;
}

export const DEFAULT_PATTERNS: Patterns = { checkJob: CHECK_JOB, ciOnlyJob: CI_ONLY_JOB };

export function bucketJob(job: JobSummary, patterns: Patterns = DEFAULT_PATTERNS): JobBucket {
  if (job.failedSteps.length === 0) return "infra"; // cancelled, timed out or runner lost: no step failed
  if (job.failedSteps.every((step) => INFRA_STEP.test(step))) return "infra";
  if (job.failedSteps.every((step) => CI_ONLY_STEP.test(step))) return "ci-only";
  // The job's own name, without a "Workflow / " prefix, decides. CI-only wins so "e2e tests" is not a check.
  const name = jobName(job);
  // A --ci-only-jobs override wins outright; by default only the strong CI-only words beat a check word.
  const ciOnlyFirst = patterns.ciOnlyJob === CI_ONLY_JOB ? CI_ONLY_STRONG : patterns.ciOnlyJob;
  if (ciOnlyFirst.test(name)) return "ci-only";
  if (patterns.checkJob.test(name)) return "check";
  return "ci-only"; // a CI-side job by name, or one matching neither list: never inflates the preventable count
}

/** The job's own name, without a "Workflow / " or "caller / " prefix. */
function jobName(job: JobSummary): string {
  return (job.name.split(" / ").at(-1) ?? job.name).trim();
}

export function isAggregateJob(job: JobSummary): boolean {
  return AGGREGATE_JOB.test(jobName(job).replace(/[()]/g, "").trim());
}

/** Failure signatures of one job: annotation path, title and first message line, with volatile parts blurred. */
export function signatures(annotations: Annotation[]): Set<string> {
  const out = new Set<string>();
  for (const a of annotations) {
    if (a.level !== "failure") continue;
    const first = (a.message ?? "").trim().split(/\r?\n/)[0] ?? "";
    if (GENERIC_ANNOTATION.test(first) || (!first && !a.title)) continue;
    if (!a.path || a.path === ".github") continue; // runner-level messages, not a test or lint failure
    const text = `${a.path} :: ${a.title ?? ""} :: ${first}`.replace(/\/tmp\/\S+|[0-9a-f]{7,}|\d+(\.\d+)?/g, "#");
    out.add(text.slice(0, 300));
  }
  return out;
}

function minutes(job: JobSummary): number {
  if (!job.startedAt || !job.completedAt) return 0;
  return Math.max(0, (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 60_000);
}

export interface RedRun {
  run: number;
  workflow: string;
  attempt: number;
  fork: boolean;
  verdict: Verdict;
  failingJobs: Array<{ name: string; bucket: JobBucket; ownership?: "own" | "shared" | "timeout" | "unknown" }>;
  runnerMinutes: number;
  agent?: { written: boolean; marker: string; commitRead: boolean };
}

export interface ClassifyInput {
  repository: string;
  runs: RunSummary[];
  /** Jobs of the latest attempt of each red run, by run id. Missing: the job list could not be read. */
  jobs: Map<number, JobSummary[]>;
  /** Failure annotations by job id. Missing: not fetched or unreadable. */
  annotations: Map<number, Annotation[]>;
  patterns?: Patterns;
}

/** Pure: sorts every red run whose jobs were read into one verdict. */
export function classify(input: ClassifyInput): RedRun[] {
  const patterns = input.patterns ?? DEFAULT_PATTERNS;
  const passed = new Set(input.runs.filter((r) => r.conclusion === "success").map((r) => `${r.workflowId}:${r.headSha}`));
  const prKey = (r: RunSummary) => `${r.headRepo}:${r.headBranch}`;
  const failingOf = (jobs: JobSummary[]) => jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out");

  // Which PRs each failure signature appeared on, across the whole window.
  const seen = new Map<string, Set<string>>();
  for (const run of input.runs) {
    const jobs = input.jobs.get(run.id);
    if (run.conclusion !== "failure" || !jobs) continue;
    for (const job of failingOf(jobs)) {
      if (bucketJob(job, patterns) !== "check") continue;
      for (const sig of signatures(input.annotations.get(job.id) ?? [])) {
        if (!seen.has(sig)) seen.set(sig, new Set());
        seen.get(sig)!.add(prKey(run));
      }
    }
  }

  const rows: RedRun[] = [];
  for (const run of input.runs) {
    const jobs = input.jobs.get(run.id);
    if (run.conclusion !== "failure" || !jobs) continue;
    const allFailing = failingOf(jobs);
    // A gate job that only reports "something else failed" says nothing on its own.
    const failing = allFailing.some((j) => !isAggregateJob(j)) ? allFailing.filter((j) => !isAggregateJob(j)) : allFailing;
    const detail = failing.map((job) => {
      const bucket = bucketJob(job, patterns);
      if (bucket !== "check") return { name: job.name, bucket };
      const annotations = input.annotations.get(job.id);
      const sigs = signatures(annotations ?? []);
      let ownership: "own" | "shared" | "timeout" | "unknown";
      if (sigs.size === 0) ownership = "unknown";
      else if ([...sigs].every((s) => TIMEOUT.test(s))) ownership = "timeout";
      else if ([...sigs].some((s) => !TIMEOUT.test(s) && (seen.get(s)?.size ?? 0) > 1)) ownership = "shared";
      else ownership = "own";
      return { name: job.name, bucket, ownership };
    });
    const real = detail.filter((d) => d.bucket !== "infra");
    const checks = real.filter((d) => d.bucket === "check");
    const ciOnly = real.some((d) => d.bucket === "ci-only");
    let verdict: Verdict;
    if (real.length === 0) verdict = "infra";
    else if (passed.has(`${run.workflowId}:${run.headSha}`)) verdict = "flaky";
    else if (checks.length === 0) verdict = "ci-only";
    else if (checks.every((d) => d.ownership === "own") && !ciOnly) verdict = "preventable";
    else if (checks.some((d) => d.ownership === "own")) verdict = "partly";
    else if (checks.every((d) => d.ownership === "unknown") && !ciOnly) verdict = "likely";
    else if (checks.some((d) => d.ownership === "shared")) verdict = "shared";
    else verdict = ciOnly ? "ci-only" : "likely";
    rows.push({
      run: run.id,
      workflow: run.workflowName,
      attempt: run.attempt,
      fork: run.headRepo !== input.repository,
      verdict,
      failingJobs: detail,
      runnerMinutes: Math.round(jobs.reduce((sum, job) => sum + minutes(job), 0) * 10) / 10,
    });
  }
  return rows;
}

export function agentMarker(message: string, branch: string): { written: boolean; marker: string } {
  const trailer = AGENT_TRAILER.exec(message);
  if (trailer) return { written: true, marker: (trailer[1] ?? trailer[2] ?? "agent").toLowerCase() };
  if (AGENT_BRANCH.test(branch)) return { written: true, marker: "branch prefix" };
  return { written: false, marker: "" };
}

export interface RedBuildsReport {
  schemaVersion: typeof RED_BUILDS_SCHEMA;
  repository: string;
  /** The workflow whose pull request runs were read. */
  workflow: string | null;
  window: { from: string; to: string } | null;
  pullRequestRuns: number;
  redRuns: number;
  analysed: number;
  unreadable: number;
  verdicts: Record<Verdict, { runs: number; runnerMinutes: number }>;
  agentWrittenPreventable: number;
  stoppedEarly: string | null;
  rows: RedRun[];
}

export function summarise(repository: string, runs: RunSummary[], rows: RedRun[], stoppedEarly: string | null): RedBuildsReport {
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, { runs: 0, runnerMinutes: 0 }])) as RedBuildsReport["verdicts"];
  for (const row of rows) {
    verdicts[row.verdict].runs++;
    verdicts[row.verdict].runnerMinutes += row.runnerMinutes;
  }
  for (const v of VERDICTS) verdicts[v].runnerMinutes = Math.round(verdicts[v].runnerMinutes);
  const times = runs.map((r) => r.createdAt).sort();
  const red = runs.filter((r) => r.conclusion === "failure").length;
  return {
    schemaVersion: RED_BUILDS_SCHEMA,
    repository,
    workflow: runs[0]?.workflowName ?? null,
    window: times.length ? { from: times[0]!, to: times.at(-1)! } : null,
    pullRequestRuns: runs.length,
    redRuns: red,
    analysed: rows.length,
    unreadable: red - rows.length,
    verdicts,
    agentWrittenPreventable: rows.filter((r) => r.verdict === "preventable" && r.agent?.written).length,
    stoppedEarly,
    rows,
  };
}

const LABELS: Record<Verdict, string> = {
  preventable: "Preventable before the push",
  partly: "Partly preventable",
  likely: "Likely preventable (unconfirmed)",
  shared: "Shared with other PRs",
  "ci-only": "CI-only (E2E, deploy, lockfile...)",
  flaky: "Flaky (same commit passed later)",
  infra: "Infrastructure (setup, cancelled)",
};

const NOTES: Partial<Record<Verdict, string>> = {
  preventable: "the PR's own lint, type, build or test failure",
  likely: "check jobs failed, but no annotations say whose",
  shared: "the same failure on other PRs: a broken base, not this change",
};

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "0%";
}

export function formatReport(report: RedBuildsReport): string {
  const lines: string[] = [`DiffCI red-build check: ${report.repository}${report.workflow ? ` · workflow "${report.workflow}"` : ""}`];
  if (!report.window) {
    lines.push("", "No pull request workflow runs found.");
    return lines.join("\n");
  }
  lines.push(
    `${report.window.from.slice(0, 16).replace("T", " ")} to ${report.window.to.slice(0, 16).replace("T", " ")} UTC · ${report.pullRequestRuns} pull request runs, ${report.redRuns} red (${pct(report.redRuns, report.pullRequestRuns)})`,
  );
  if (report.unreadable > 0) lines.push(`${report.unreadable} red runs could not be read and are left out.`);
  if (report.analysed === 0) {
    lines.push("", "No red runs to analyse.");
    return lines.join("\n");
  }
  lines.push("", `${"Red runs by cause".padEnd(38)}${"runs".padStart(6)}${"runner-min".padStart(12)}`);
  for (const v of VERDICTS) {
    const { runs, runnerMinutes } = report.verdicts[v];
    if (runs === 0 && v !== "preventable") continue;
    const note = NOTES[v] ? `  ${NOTES[v]}` : "";
    lines.push(`  ${LABELS[v].padEnd(36)}${String(runs).padStart(6)}${runnerMinutes.toLocaleString("en-US").padStart(12)}${note}`);
    if (v === "preventable" && runs > 0) lines.push(`    ${"written by a coding agent".padEnd(34)}${String(report.agentWrittenPreventable).padStart(6)}`);
  }
  const p = report.verdicts.preventable.runs;
  const likely = report.verdicts.likely.runs;
  lines.push(
    "",
    `Up to ${p} of ${report.analysed} red runs (${pct(p, report.analysed)}) failed only on checks the author could have run before pushing.`,
    ...(likely ? [`${likely} more failed on such checks without annotations, so whose failure it was is unconfirmed.`] : []),
    "That is an upper bound: it assumes the check ran and covered the failing test. CI history only; nothing was run.",
    "",
    "Catch these inside your coding agent's loop, before the push: npx @diffci.com/diffci init",
    "Method: https://github.com/DiffCI/core/blob/main/docs/red-builds.md",
  );
  if (report.stoppedEarly) lines.push("", `Stopped early: ${report.stoppedEarly}. The figures cover what was read.`);
  return lines.join("\n");
}

// --- GitHub access -----------------------------------------------------------------------------------

export type GitHubGet = (path: string) => Promise<{ status: number; body: unknown }>;

export class StopCollection extends Error {}

/** Paced, read-only GitHub REST client: >= 1.2 s between calls, stops on Retry-After or a low quota. */
export function githubClient(token: string, options: { minIntervalMs?: number; minRemaining?: number; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): GitHubGet {
  const interval = options.minIntervalMs ?? 1200;
  const floor = options.minRemaining ?? 1000;
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = 0;
  return async (path) => {
    const wait = last + interval - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const request = () => fetchFn(`https://api.github.com/${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "diffci-red-builds", "X-GitHub-Api-Version": "2022-11-28" },
    });
    let res: Response;
    try {
      res = await request();
    } catch {
      // A dropped connection ("fetch failed"), not a GitHub answer: one slow retry, then give up.
      await sleep(10_000);
      last = Date.now();
      res = await request();
    }
    if (res.headers.get("retry-after")) throw new StopCollection(`GitHub asked to slow down (Retry-After on ${path.split("?")[0]})`);
    const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "Infinity");
    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (res.status === 401) throw new Error("GitHub rejected the token (401)");
    if (res.status === 403 && remaining === 0) throw new StopCollection("the hourly GitHub API quota is used up");
    if (remaining < floor) throw new StopCollection(`fewer than ${floor} GitHub API calls left this hour`);
    return { status: res.status, body };
  };
}

/** Workflows that run on pull requests but are not the test CI: scanners, previews, benchmarks, bots. */
const NOT_MAIN_WORKFLOW = /\b(preview|codeql|security|semgrep|sonar(qube|cloud)?|snyk|scorecard|bench(mark)?s?|size|label(er|s)?|stale|triage|greet(ings?)?|welcome|translations?|i18n|docs?|documentation|docker|image|deploy(ment)?|release|licen[cs]e|title|conventional|commits?|semantic|submodule|e2e|playwright|cypress|lighthouse|dependabot|renovate|cla|dco|changeset|storybook|chromatic)\b/i;
/** Names and file names the main pull request CI usually has. */
const MAIN_WORKFLOW = /\b(ci|cd|tests?|pipeline|pr|pull[-_ ]request|build|checks?|main|verify|validate|unit|lint|quality)\b/i;

/**
 * The main pull request CI among one sample page of runs: wall-clock minutes per workflow, doubled when
 * its name or file looks like CI and cut to 5% when it looks like a scanner, preview, benchmark or bot.
 * Plain "most minutes" picked SonarQube, Benchmarks and preview builds on real repositories.
 */
export function pickMainWorkflow(sample: any[]): { id: number; name: string; path: string } | undefined {
  const weight = new Map<number, { name: string; path: string; minutes: number }>();
  for (const r of sample) {
    const span = (Date.parse(r.updated_at) - Date.parse(r.run_started_at ?? r.created_at)) / 60_000;
    const path = String(r.path ?? "").replace(/^\.github\/workflows\//, "");
    const entry = weight.get(r.workflow_id) ?? { name: String(r.name ?? r.workflow_id), path, minutes: 0 };
    entry.minutes += Number.isFinite(span) && span > 0 ? span : 0;
    weight.set(r.workflow_id, entry);
  }
  let best: { id: number; name: string; path: string; score: number } | undefined;
  for (const [id, w] of weight) {
    const text = `${w.name} ${w.path.replace(/\.ya?ml$/, "").replace(/[-_.]/g, " ")}`;
    const score = (w.minutes + 0.01) * (NOT_MAIN_WORKFLOW.test(text) ? 0.05 : 1) * (MAIN_WORKFLOW.test(text) ? 2 : 1);
    if (!best || score > best.score) best = { id, name: w.name, path: w.path, score };
  }
  return best && { id: best.id, name: best.name, path: best.path };
}

export interface CollectOptions {
  repository: string;
  get: GitHubGet;
  maxRuns: number;
  workflow?: string;
  patterns?: Patterns;
  log?: (line: string) => void;
}

/** Fetches runs, jobs, annotations and commit messages, then classifies. Partial data on a stop. */
export async function collectRedBuilds(options: CollectOptions): Promise<RedBuildsReport> {
  const { repository, get } = options;
  const log = options.log ?? (() => undefined);
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  const runs: RunSummary[] = [];
  const jobs = new Map<number, JobSummary[]>();
  const annotations = new Map<number, Annotation[]>();
  let stoppedEarly: string | null = null;
  let workflow = options.workflow;
  let workflowLabel = workflow ?? "";

  try {
    if (!workflow) {
      // Default: the heaviest pull request workflow (most wall-clock time in one sample page), which is the
      // main CI in practice. Counting runs of every workflow lets labelers and bots flood the window.
      const { status, body } = await get(`repos/${repository}/actions/runs?event=pull_request&per_page=100`);
      if (status === 404) throw new Error(`${repository} not found, or its Actions history is not visible to this token`);
      if (status !== 200) throw new Error(`listing workflow runs failed (HTTP ${status})`);
      const chosen = pickMainWorkflow((body as { workflow_runs?: any[] })?.workflow_runs ?? []);
      if (!chosen) return summarise(repository, [], [], null);
      workflow = String(chosen.id);
      workflowLabel = chosen.name;
      log(`Using the "${workflowLabel}" workflow (${chosen.path}), which looks like the main pull request CI. Pass --workflow to choose another.`);
    }
    const base = `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
    for (let page = 1; runs.length < options.maxRuns; page++) {
      const { status, body } = await get(`${base}?event=pull_request&per_page=100&page=${page}`);
      if (status === 404) throw new Error(`${repository} workflow ${workflow} not found, or its Actions history is not visible to this token`);
      if (status !== 200) throw new Error(`listing workflow runs failed (HTTP ${status})`);
      const batch = ((body as { workflow_runs?: any[] })?.workflow_runs ?? []);
      for (const r of batch.slice(0, options.maxRuns - runs.length)) {
        runs.push({
          id: r.id, workflowId: r.workflow_id, workflowName: String(r.name ?? ""), attempt: r.run_attempt ?? 1,
          headSha: r.head_sha, headBranch: String(r.head_branch ?? ""), headRepo: String(r.head_repository?.full_name ?? ""),
          conclusion: r.conclusion ?? null, createdAt: r.created_at,
        });
      }
      if (batch.length < 100) break;
    }
    const red = runs.filter((r) => r.conclusion === "failure");
    log(`${runs.length} pull request runs, ${red.length} red. Reading their jobs...`);

    for (const run of red) {
      const list: JobSummary[] = [];
      let readable = true;
      for (let page = 1; ; page++) {
        const { status, body } = await get(`repos/${repository}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`);
        if (status !== 200) { readable = false; break; }
        const batch = ((body as { jobs?: any[] })?.jobs ?? []);
        for (const j of batch) {
          list.push({
            id: j.id, name: String(j.name ?? ""), conclusion: j.conclusion ?? null, startedAt: j.started_at ?? null, completedAt: j.completed_at ?? null,
            failedSteps: (j.steps ?? []).filter((s: any) => s.conclusion === "failure").map((s: any) => String(s.name ?? "")),
          });
        }
        if (batch.length < 100) break;
      }
      if (readable) jobs.set(run.id, list);
    }

    const checkJobs = red.flatMap((run) => (jobs.get(run.id) ?? []).filter((j) => (j.conclusion === "failure" || j.conclusion === "timed_out") && bucketJob(j, patterns) === "check"));
    log(`Reading failure annotations of ${checkJobs.length} failing check jobs...`);
    for (const job of checkJobs) {
      const { status, body } = await get(`repos/${repository}/check-runs/${job.id}/annotations?per_page=50`);
      if (status !== 200 || !Array.isArray(body)) continue;
      annotations.set(job.id, body.map((a: any) => ({ path: a.path ?? null, title: a.title ?? null, message: a.message ?? null, level: a.annotation_level ?? null })));
    }
  } catch (error) {
    if (!(error instanceof StopCollection)) throw error;
    stoppedEarly = error.message;
  }

  const rows = classify({ repository, runs, jobs, annotations, patterns });

  if (!stoppedEarly) {
    const byId = new Map(runs.map((r) => [r.id, r]));
    const preventable = rows.filter((r) => r.verdict === "preventable");
    if (preventable.length) log(`Checking ${preventable.length} preventable head commits for coding-agent co-authors...`);
    try {
      for (const row of preventable) {
        const run = byId.get(row.run)!;
        const { status, body } = await get(`repos/${repository}/commits/${run.headSha}`);
        const message = status === 200 ? String((body as any)?.commit?.message ?? "") : "";
        row.agent = { ...agentMarker(message, run.headBranch), commitRead: status === 200 };
      }
    } catch (error) {
      if (!(error instanceof StopCollection)) throw error;
      stoppedEarly = error.message;
    }
  }
  const report = summarise(repository, runs, rows, stoppedEarly);
  report.workflow = workflowLabel || runs[0]?.workflowName || null;
  return report;
}

export function resolveGitHubToken(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = gh.status === 0 ? gh.stdout.trim() : "";
  return token || undefined;
}

export const RED_BUILDS_USAGE = `Usage: diffci red-builds <owner/repo> [--runs <n>] [--workflow <id|file>] [--json <file>]
              [--check-jobs <regex>] [--ci-only-jobs <regex>]
How many of a repository's red pull request builds failed on checks the author could have run before
pushing. Reads GitHub Actions history (read-only, paced) and runs nothing. Needs a GitHub token:
GITHUB_TOKEN, GH_TOKEN, or a signed-in gh CLI. --runs: most recent pull request runs to read (default 200,
max 1000). --check-jobs / --ci-only-jobs: regexes that override which job names count as local checks.`;

/** Entry point for `diffci red-builds`. Returns the exit code: 0 on a report, 2 on bad input or errors. */
export async function runRedBuildsCommand(args: string[], env: NodeJS.ProcessEnv = process.env, deps: { get?: GitHubGet } = {}): Promise<number> {
  let repository: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") { console.log(RED_BUILDS_USAGE); return 0; }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (!["runs", "workflow", "json", "check-jobs", "ci-only-jobs"].includes(name)) { console.error(`Unsupported red-builds argument: --${name}\n\n${RED_BUILDS_USAGE}`); return 2; }
      const value = inline ?? args[++i];
      if (value === undefined) { console.error(`--${name} needs a value`); return 2; }
      flags[name] = value;
    } else if (!repository) repository = arg;
    else { console.error(`Unexpected argument: ${arg}\n\n${RED_BUILDS_USAGE}`); return 2; }
  }
  if (!repository || !REPOSITORY.test(repository)) { console.error(`red-builds needs a repository as owner/name.\n\n${RED_BUILDS_USAGE}`); return 2; }
  const maxRuns = flags.runs === undefined ? 200 : Number(flags.runs);
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) { console.error("--runs must be a whole number from 1 to 1000"); return 2; }
  let patterns: Patterns;
  try {
    patterns = {
      checkJob: flags["check-jobs"] ? new RegExp(flags["check-jobs"], "i") : CHECK_JOB,
      ciOnlyJob: flags["ci-only-jobs"] ? new RegExp(flags["ci-only-jobs"], "i") : CI_ONLY_JOB,
    };
  } catch (error) {
    console.error(`Invalid job regex: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let get = deps.get;
  if (!get) {
    const token = resolveGitHubToken(env);
    if (!token) { console.error("red-builds needs a GitHub token: set GITHUB_TOKEN or GH_TOKEN, or sign in with `gh auth login`. Unauthenticated access allows only 60 calls an hour."); return 2; }
    get = githubClient(token);
  }
  try {
    const report = await collectRedBuilds({ repository, get, maxRuns, workflow: flags.workflow, patterns, log: (line) => console.error(line) });
    console.log(formatReport(report));
    if (flags.json) writeFileSync(flags.json, `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`DiffCI red-builds failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
