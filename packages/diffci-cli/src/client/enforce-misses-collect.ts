/**
 * The side effects of miss detection (docs/enforce-mode-01-plan.md, step 5): finding the window, the
 * pull requests merged in it, their dry-run receipts, and re-running the failing test files. GitHub is
 * reached only through the `gh` CLI, and every external call goes through an injectable runner.
 *
 * The window starts at the most recent earlier run of the detector itself (its uploaded report lists
 * the failures that were already there), or, before the first such run exists, at the last green
 * `ci.yml` push run on `main`. Either commit must be an ancestor of the commit being checked.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MISS_REPORT_SCHEMA, parseJunit, type MergedPullRequest, type MissReport, type ReceiptFields, type TestOutcome, type WindowSource } from "./enforce-misses.js";
import { VERIFICATION_SCHEMA } from "./verify.js";

export const DRY_RUN_ARTIFACT_PREFIX = "diffci-enforce-dry-run-";
export const MISS_RECORD_ARTIFACT_PREFIX = "diffci-enforce-misses-";
export const MISS_REPORT_FILE = "enforce-misses.json";
const DRY_RUN_RECEIPT_FILE = "diffci-enforce-dry-run.json";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (executable: string, args: string[], options?: { cwd?: string }) => RunResult;

export const spawnRunner: CommandRunner = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
};

export interface CollectOptions {
  repoPath: string;
  /** owner/name */
  repository: string;
  headSha: string;
  /** This run's id, skipped when looking for an earlier detector record. */
  runId?: string;
  /** Scratch directory for downloaded artifacts; outside the checkout. */
  workDir: string;
  run: CommandRunner;
  detectorWorkflow?: string;
  fullSuiteWorkflow?: string;
  dryRunWorkflow?: string;
  /** Upper bound on first-parent commits examined, so a long red streak cannot fan out without limit. */
  maxCommits?: number;
}

interface WorkflowRun {
  id: number;
  head_sha: string;
}

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
}

function ghJson<T>(options: CollectOptions, path: string): T | undefined {
  const result = options.run("gh", ["api", path]);
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

function isAncestor(options: CollectOptions, ancestor: string): boolean {
  return options.run("git", ["merge-base", "--is-ancestor", ancestor, options.headSha], { cwd: options.repoPath }).ok;
}

function workflowRuns(options: CollectOptions, workflow: string, query: string): WorkflowRun[] {
  return ghJson<{ workflow_runs?: WorkflowRun[] }>(options, `repos/${options.repository}/actions/workflows/${workflow}/runs?${query}`)?.workflow_runs ?? [];
}

function runArtifacts(options: CollectOptions, runId: number, prefix: string): Artifact[] {
  const artifacts = ghJson<{ artifacts?: Artifact[] }>(options, `repos/${options.repository}/actions/runs/${runId}/artifacts?per_page=100`)?.artifacts ?? [];
  return artifacts.filter((artifact) => !artifact.expired && artifact.name.startsWith(prefix));
}

/** Download one artifact and parse the named JSON file from it. */
function downloadJson(options: CollectOptions, runId: number, artifact: string, file: string): unknown {
  mkdirSync(options.workDir, { recursive: true });
  const directory = mkdtempSync(join(options.workDir, "artifact-"));
  const result = options.run("gh", ["run", "download", String(runId), "--repo", options.repository, "--name", artifact, "--dir", directory]);
  if (!result.ok) return undefined;
  const path = join(directory, file);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export interface WindowStart {
  fromSha: string | null;
  source: WindowSource;
  baseline: string[];
}

export function findWindowStart(options: CollectOptions): WindowStart {
  const detector = options.detectorWorkflow ?? "diffci-enforce-misses.yml";
  for (const run of workflowRuns(options, detector, "branch=main&status=completed&per_page=30")) {
    if (String(run.id) === options.runId || !isAncestor(options, run.head_sha)) continue;
    for (const artifact of runArtifacts(options, run.id, MISS_RECORD_ARTIFACT_PREFIX)) {
      const record = downloadJson(options, run.id, artifact.name, MISS_REPORT_FILE) as Partial<MissReport> | undefined;
      if (record?.schema === MISS_REPORT_SCHEMA && Array.isArray(record.deterministic_failures)) {
        return { fromSha: run.head_sha, source: "detector-record", baseline: record.deterministic_failures };
      }
    }
  }
  const fullSuite = options.fullSuiteWorkflow ?? "ci.yml";
  for (const run of workflowRuns(options, fullSuite, "branch=main&event=push&status=success&per_page=30")) {
    if (isAncestor(options, run.head_sha)) return { fromSha: run.head_sha, source: "green-full-run", baseline: [] };
  }
  return { fromSha: null, source: "none", baseline: [] };
}

interface PullSummary {
  number: number;
  title?: string;
  merged_at: string | null;
  base?: { ref?: string };
  head?: { sha?: string };
}

/** Pull requests merged into `main` by the first-parent commits after `fromSha`, oldest first. */
export function mergedPullRequests(options: CollectOptions, fromSha: string | null): MergedPullRequest[] {
  if (!fromSha) return [];
  const listed = options.run("git", ["rev-list", "--first-parent", "--reverse", `${fromSha}..${options.headSha}`], { cwd: options.repoPath });
  if (!listed.ok) return [];
  const commits = listed.stdout.split(/\s+/).filter(Boolean).slice(-(options.maxCommits ?? 100));
  const found = new Map<number, MergedPullRequest>();
  for (const sha of commits) {
    for (const pull of ghJson<PullSummary[]>(options, `repos/${options.repository}/commits/${sha}/pulls`) ?? []) {
      if (!pull.merged_at || pull.base?.ref !== "main" || !pull.head?.sha || found.has(pull.number)) continue;
      found.set(pull.number, { number: pull.number, title: pull.title, mergeSha: sha, headSha: pull.head.sha });
    }
  }
  return [...found.values()];
}

/** The newest dry-run receipt recorded for the pull request's final head commit. */
export function findReceipt(options: CollectOptions, pr: MergedPullRequest): MergedPullRequest["receipt"] {
  const workflow = options.dryRunWorkflow ?? "diffci-enforce-dry-run.yml";
  for (const run of workflowRuns(options, workflow, `head_sha=${pr.headSha}&per_page=20`)) {
    for (const artifact of runArtifacts(options, run.id, `${DRY_RUN_ARTIFACT_PREFIX}${pr.number}-`)) {
      const report = downloadJson(options, run.id, artifact.name, DRY_RUN_RECEIPT_FILE) as ReceiptFields | undefined;
      if (report?.schema === VERIFICATION_SCHEMA) return { artifact: artifact.name, report };
    }
  }
  return undefined;
}

/**
 * Node arguments that re-run test files the way package.json's `tsx --test` script runs them: tsx's own
 * CLI under this Node, so no shell and no `.cmd` shim is involved and test paths stay literal argv.
 */
export function inferRerunArgs(repoPath: string): string[] | undefined {
  try {
    const script: unknown = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")).scripts?.test;
    if (typeof script !== "string") return undefined;
    const runners = [...script.matchAll(/\btsx(?:\s+--conditions\s+([\w,-]+))?\s+--test\b/g)];
    if (runners.length !== 1) return undefined;
    const cli = createRequire(join(repoPath, "package.json")).resolve("tsx/cli");
    const conditions = runners[0]![1];
    return [cli, ...(conditions ? ["--conditions", conditions] : []), "--test"];
  } catch {
    return undefined;
  }
}

/**
 * Re-run only the failing files with node:test's JUnit reporter, set through NODE_OPTIONS so the runner
 * arguments stay what package.json declares. Returns undefined when no result file was written.
 */
export function rerunFailingFiles(repoPath: string, runnerArgs: readonly string[], files: readonly string[]): TestOutcome[] | undefined {
  const directory = mkdtempSync(join(tmpdir(), "diffci-misses-rerun-"));
  const junit = join(directory, "rerun.junit.xml");
  try {
    spawnSync(process.execPath, [...runnerArgs, ...files], {
      cwd: repoPath,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=junit", `--test-reporter-destination=${junit}`]
          .filter(Boolean)
          .join(" "),
      },
    });
    if (!existsSync(junit)) return undefined;
    return parseJunit(readFileSync(junit, "utf8"), repoPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
