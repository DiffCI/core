// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { RepositoryProfile } from "../../repo/types.js";
import { detectTestCommand } from "./test-activity.js";

export interface ParsedWorkflowTask {
  id: string;
  name?: string;
  category?: string;
  pathGlobs?: string[];
  pathIgnoreGlobs?: string[];
  dependsOn?: string[];
  /** Stage 2C (2026-08-21) measurement-pipeline repair - see test-activity.ts's module doc comment for
   * the full rationale. Computed independently of `category` (which stays exactly as inferCategory()
   * always produced it, for planner-facing callers) from this job's real `run:` command text, resolved
   * one level through package.json scripts. Consumed ONLY by evidence-collector.ts's
   * filterToTestCategoryTaskIds - never read by any planning/selection/fallback logic. */
  hasTestCommand: boolean;
}

export interface ParsedWorkflow {
  path: string;
  name?: string;
  tasks: ParsedWorkflowTask[];
}

export function parseRepositoryWorkflows(profile: RepositoryProfile, repoPath: string): ParsedWorkflow[] {
  const scripts = profile.packageJson?.scripts ?? {};
  return profile.workflows.map((w) => parseWorkflow(resolve(repoPath, w.path), w.path, scripts));
}

function parseWorkflow(absolutePath: string, relativePath: string, scripts: Record<string, string>): ParsedWorkflow {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch {
    return { path: relativePath, tasks: [] };
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw) as unknown;
  } catch {
    return { path: relativePath, tasks: [] };
  }

  const name = typeof (doc as Record<string, unknown>).name === "string" ? (doc as Record<string, unknown>).name as string : relativePath;
  const tasks: ParsedWorkflowTask[] = [];
  const jobs = (doc as Record<string, unknown>).jobs as Record<string, unknown> | undefined;
  if (!jobs || typeof jobs !== "object") return { path: relativePath, name, tasks };

  const filters = workflowPathFilters((doc as Record<string, unknown>).on);
  for (const [jobId, jobValue] of Object.entries(jobs)) {
    if (!jobValue || typeof jobValue !== "object") continue;
    const job = jobValue as Record<string, unknown>;
    const namePart = typeof job.name === "string" ? job.name : jobId;
    const paths = filters.paths ?? [];
    const pathsIgnore = filters.pathsIgnore ?? [];
    const dependsOn = normalizeStringArray(job.needs) ?? [];
    const stepNames: string[] = [];
    const runLines: string[] = [];
    const steps = Array.isArray(job.steps) ? (job.steps as Record<string, unknown>[]) : [];
    for (const step of steps) {
      if (typeof step?.name === "string") stepNames.push(step.name as string);
      if (typeof step?.run === "string") runLines.push(step.run as string);
    }

    const category = inferCategory(namePart + " " + stepNames.join(" "));
    tasks.push({
      id: `${relativePath.replace(/.ya?ml$/, "")}::${jobId}`,
      name: namePart,
      category,
      pathGlobs: paths.length > 0 ? paths : undefined,
      pathIgnoreGlobs: pathsIgnore.length > 0 ? pathsIgnore : undefined,
      dependsOn,
      // Stage 2C: real `run:` command text, resolved one level through package.json scripts - see
      // ParsedWorkflowTask.hasTestCommand's doc comment. Independent of `category` above.
      hasTestCommand: detectTestCommand(runLines, scripts),
    });
  }

  return { path: relativePath, name, tasks };
}

/** The triggers whose runs a change's paths decide. */
const PATH_FILTERED_EVENTS = ["push", "pull_request", "pull_request_target"];
/** Characters every glob matcher here reads the way GitHub does; anything else keeps the defaults. */
const PLAIN_GLOB = /^[A-Za-z0-9_.@/*{},-]+$/;

/**
 * The workflow-level `on.<event>.paths` / `paths-ignore` filters (#177). GitHub has no job-level `paths`,
 * so the job is gated by the workflow's triggers. A filter is reported only when it bounds every
 * push/pull_request trigger the workflow has: a trigger without one runs the workflow for any change.
 * Negated or non-plain patterns are left out, so they can never be read more narrowly than GitHub reads them.
 */
function workflowPathFilters(on: unknown): { paths?: string[]; pathsIgnore?: string[] } {
  if (!on || typeof on !== "object" || Array.isArray(on)) return {};
  const triggers = PATH_FILTERED_EVENTS.filter((event) => event in on).map((event) => (on as Record<string, unknown>)[event]);
  if (triggers.length === 0) return {};
  const collect = (key: "paths" | "paths-ignore"): string[] | undefined => {
    const lists = triggers.map((trigger) => trigger && typeof trigger === "object" && !Array.isArray(trigger) ? normalizeStringArray((trigger as Record<string, unknown>)[key]) : undefined);
    if (lists.some((list) => !list || list.length === 0)) return undefined;
    const patterns = [...new Set(lists.flat() as string[])];
    return patterns.every((pattern) => PLAIN_GLOB.test(pattern) && !hasPartialGlobstar(pattern)) ? patterns : undefined;
  };
  return { paths: collect("paths"), pathsIgnore: collect("paths-ignore") };
}

/**
 * Whether `pattern` has a `**` the planner's matcher would read more narrowly than GitHub: one that is not a
 * whole path segment between slashes (`**.js`, `src**`, `{**,x}`), or a bare `**`. GitHub lets those cross
 * directories, but the planner reads them as `*`, so a filter of `'**'` would only match top-level files.
 */
function hasPartialGlobstar(pattern: string): boolean {
  if (pattern === "**") return true;
  for (const match of pattern.matchAll(/\*{2,}/g)) {
    const before = pattern[match.index - 1];
    const after = pattern[match.index + match[0].length];
    if (match[0].length !== 2 || (before !== undefined && before !== "/") || (after !== undefined && after !== "/")) return true;
  }
  return false;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return undefined;
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("typecheck") || lower.includes("typescript") || lower.includes("tsc")) return "typecheck";
  if (lower.includes("lint")) return "lint";
  if (lower.includes("security") || lower.includes("audit") || lower.includes("snyk")) return "security";
  if (lower.includes("build")) return "build";
  if (lower.includes("e2e") || lower.includes("playwright") || lower.includes("cypress")) return "e2e";
  if (lower.includes("integration")) return "integration";
  if (lower.includes("unit") || lower.includes("test")) return "test";
  if (lower.includes("deploy")) return "deploy";
  if (lower.includes("infra") || lower.includes("terraform")) return "infrastructure";
  return "validation";
}
