// SPDX-License-Identifier: MIT
/** Compare one advisory selection with failures in the supplied full-suite JUnit report. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { readJunit, junitFile, attributeJunitFile, normalizeTestPath, type JunitFailure } from "./check-plan-junit.js";

interface PlanSelection {
  mode: "SELECTIVE" | "FULL";
  selected: Set<string>;
  skipped: Set<string>;
}

export interface PlanCheckFailure {
  name: string;
  classname?: string;
  suite?: string;
  reportedFile?: string;
  file?: string;
}

export interface UnattributedPlanFailure extends PlanCheckFailure {
  reason: string;
  candidates?: string[];
}

export interface PlanCheckReport {
  schemaVersion: 1;
  mode: "SELECTIVE" | "FULL";
  fullFallback: boolean;
  baselineProvided: boolean;
  summary: { failedTests: number; missed: number; possibleMisses: number; preExisting: number; selected: number; unattributed: number };
  possibleMisses: PlanCheckFailure[];
  preExisting: PlanCheckFailure[];
  missed: PlanCheckFailure[];
  selected: PlanCheckFailure[];
  unattributed: UnattributedPlanFailure[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function planPaths(value: unknown, field: string): Set<string> {
  if (!Array.isArray(value)) throw new Error(`Plan ${field} must be an array of repository-relative file paths`);
  const paths = new Set<string>();
  for (const path of value) {
    if (typeof path !== "string" || path.length === 0 || /[\\\x00-\x1f\x7f]/.test(path)
      || path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)
      || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Plan ${field} contains a noncanonical repository-relative path`);
    }
    if (paths.has(path)) throw new Error(`Plan ${field} contains the duplicate path ${JSON.stringify(path)}`);
    paths.add(path);
  }
  return paths;
}

function readSelection(input: unknown): PlanSelection {
  if (!record(input)) throw new Error("Expected an ExecutionPlan or the JSON output of Core's plan command");
  let plan = input;
  if (Object.hasOwn(input, "plan")) {
    if (input.advisoryOnly !== true || typeof input.base !== "string" || !input.base
      || typeof input.head !== "string" || !input.head || !record(input.plan)
      || ["mode", "selectedTests", "skippedTests"].some((key) => Object.hasOwn(input, key))) {
      throw new Error("Expected an unambiguous Core plan output with advisoryOnly, base, head and plan");
    }
    plan = input.plan;
  }
  if (plan.version !== "5.0.0") throw new Error("Unsupported plan version; expected ExecutionPlan version 5.0.0");
  if (plan.mode !== "SELECTIVE" && plan.mode !== "FULL") throw new Error("Plan mode must be SELECTIVE or FULL");
  if (!record(plan.safety) || typeof plan.safety.fallbackRequired !== "boolean"
    || plan.safety.fallbackRequired !== (plan.mode === "FULL")) {
    throw new Error("Plan safety.fallbackRequired must agree with its mode");
  }
  const selected = planPaths(plan.selectedTests, "selectedTests");
  const skipped = planPaths(plan.skippedTests, "skippedTests");
  for (const path of selected) {
    if (skipped.has(path)) throw new Error(`Plan selects and skips the same file: ${JSON.stringify(path)}`);
  }
  if (plan.mode === "FULL" && skipped.size > 0) throw new Error("A FULL plan cannot contain skipped tests");
  return { mode: plan.mode, selected, skipped };
}

export interface PlanCheckOptions {
  /** JUnit results from the plan's base revision, produced with the same reporter configuration. */
  baseResults?: string;
  /** Absolute checkout root that produced the base report. Defaults to repoRoot. */
  baseRepoRoot?: string;
  /** Absolute checkout root for absolute reporter paths. Defaults to the current directory. */
  repoRoot?: string;
  /** Reporter root, relative to the repository root. */
  root?: string;
}

function identity(test: JunitFailure, file: string, repoRoot: string, root: string): string {
  const label = (value: string) => /\.[cm]?[jt]sx?$/.test(value) ? normalizeTestPath(value, repoRoot, root) || value : value;
  // Keep stored keys bounded even when many passing cases inherit long describe names.
  return createHash("sha256").update(JSON.stringify([file, test.suiteNames.map(label), label(test.classname ?? ""), test.name])).digest("hex");
}

function reporterRoot(value = "."): string {
  const path = value.replace(/\\/g, "/");
  if (!path || /[\x00-\x1f\x7f]/.test(path) || path.startsWith("/")
    || /^[a-z][a-z\d+.-]*:/i.test(path) || path.split("/").includes("..")) {
    throw new Error("Invalid --root: expected a directory inside the repository, without parent traversal");
  }
  return posix.normalize(path).replace(/\/$/, "") || ".";
}

/** This checks selection against supplied results, not suite success or report/revision provenance. */
export function checkPlan(planInput: unknown, junitXml: string, options: PlanCheckOptions = {}): PlanCheckReport {
  const root = reporterRoot(options.root);
  const repoRoot = options.repoRoot ?? process.cwd();
  const baseRepoRoot = options.baseRepoRoot ?? repoRoot;
  const plan = readSelection(planInput);
  const known = new Set([...plan.selected, ...plan.skipped]);
  const headCounts = new Map<string, number>();
  const baseCounts = new Map<string, number>();
  const baseline = new Set<string>();
  const basePassed = new Set<string>();
  function count(test: JunitFailure, counts: Map<string, number>, checkout: string): string | undefined {
    const file = junitFile(test, checkout, root);
    // Missing names and ambiguous file identities cannot establish an old failure.
    if (!known.has(file) || !test.name) return undefined;
    const key = identity(test, file, checkout, root);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return key;
  }
  const results = readJunit(junitXml, options.baseResults === undefined ? undefined
    : (test) => { count(test, headCounts, repoRoot); });
  if (options.baseResults !== undefined) {
    readJunit(options.baseResults, (test, failed, skipped) => {
      const key = count(test, baseCounts, baseRepoRoot);
      if (key !== undefined && failed) baseline.add(key);
      if (key !== undefined && !failed && !skipped) basePassed.add(key);
    });
  }
  const missed: PlanCheckFailure[] = [];
  const possibleMisses: PlanCheckFailure[] = [];
  const preExisting: PlanCheckFailure[] = [];
  const selected: PlanCheckFailure[] = [];
  const unattributed: UnattributedPlanFailure[] = [];
  for (const failure of results.failures) {
    const details: PlanCheckFailure = {
      name: failure.name,
      ...(failure.classname === undefined ? {} : { classname: failure.classname }),
      ...(failure.suite === undefined ? {} : { suite: failure.suite }),
      ...(failure.file === undefined ? {} : { reportedFile: failure.file }),
    };
    const attribution = attributeJunitFile(failure, repoRoot, root);
    if (!("file" in attribution)) {
      unattributed.push({ ...details, ...attribution });
      continue;
    }
    const file = attribution.file;
    if (!known.has(file)) {
      unattributed.push({ ...details, reason: "File is absent from the supplied plan; check --root and report scope", candidates: [file] });
      continue;
    }
    const key = identity(failure, file, repoRoot, root);
    if (baseline.has(key) && baseCounts.get(key) === 1 && headCounts.get(key) === 1) {
      preExisting.push({ ...details, file });
    } else if (plan.mode === "SELECTIVE" && plan.skipped.has(file)) {
      // Repeated or unnamed identities cannot tell whether the failing occurrence changed.
      const uncertain = !basePassed.has(key) || (headCounts.get(key) ?? 0) > 1
        || (baseCounts.get(key) ?? 0) > 1
        || !failure.name;
      (uncertain ? possibleMisses : missed).push({ ...details, file });
    } else selected.push({ ...details, file });
  }
  return {
    schemaVersion: 1,
    mode: plan.mode,
    fullFallback: plan.mode === "FULL",
    baselineProvided: options.baseResults !== undefined,
    summary: { failedTests: results.failures.length, missed: missed.length, possibleMisses: possibleMisses.length, preExisting: preExisting.length, selected: selected.length, unattributed: unattributed.length },
    missed, possibleMisses, preExisting, selected, unattributed,
  };
}
