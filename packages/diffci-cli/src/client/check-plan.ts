// SPDX-License-Identifier: MIT
/** Compare one advisory selection with failures in the supplied full-suite JUnit report. */
import { parseJunitFailures, type JunitFailure } from "./check-plan-junit.js";

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
  summary: { failedTests: number; missed: number; selected: number; unattributed: number };
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

/** Reporter paths may use Windows separators; their repository-relative identity must be exact. */
function reporterPath(value: string): string | undefined {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  const slash = value.replace(/\\/g, "/");
  // Neither input supplies a trusted checkout root. A unique suffix is not proof of identity:
  // /repo/packages/new/tests/a.test.js could otherwise be mistaken for selected tests/a.test.js.
  if (slash.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(slash)) return undefined;
  if (slash.endsWith("/") || slash.endsWith("/.")) return undefined;
  const parts = slash.split("/");
  if (parts.includes("..")) return undefined;
  const path = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (!path) return undefined;
  return path;
}

function isJavascriptPath(value: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(value.replace(/\\/g, "/"));
}

type Attribution = { file: string } | { reason: string; candidates?: string[] };

function attribute(failure: JunitFailure, known: ReadonlySet<string>): Attribution {
  // File attributes carry identity; reporter titles/classnames are only a fallback convention.
  const explicit = [...(failure.file === undefined ? [] : [failure.file]), ...failure.suiteFiles];
  const values = explicit.length > 0 ? explicit
    : [...(failure.classname === undefined ? [] : [failure.classname]), ...failure.suiteNames].filter(isJavascriptPath);
  if (values.length === 0) return { reason: "No file attribute or recognizable JavaScript test-file convention" };
  const candidates = new Set<string>();
  let unmatched = false;
  for (const value of values) {
    const path = reporterPath(value);
    if (!path || !known.has(path)) unmatched = true;
    else candidates.add(path);
  }
  if (unmatched) return {
    reason: "File metadata is invalid or does not identify a file in the supplied plan",
    ...(candidates.size ? { candidates: [...candidates].sort() } : {}),
  };
  if (candidates.size !== 1) return {
    reason: "File metadata identifies multiple planned files",
    candidates: [...candidates].sort(),
  };
  return { file: [...candidates][0]! };
}

/** This checks selection against supplied results, not suite success or report/revision provenance. */
export function checkPlan(planInput: unknown, junitXml: string): PlanCheckReport {
  const plan = readSelection(planInput);
  const results = parseJunitFailures(junitXml);
  const known = new Set([...plan.selected, ...plan.skipped]);
  const missed: PlanCheckFailure[] = [];
  const selected: PlanCheckFailure[] = [];
  const unattributed: UnattributedPlanFailure[] = [];
  for (const failure of results.failures) {
    const details: PlanCheckFailure = {
      name: failure.name,
      ...(failure.classname === undefined ? {} : { classname: failure.classname }),
      ...(failure.suite === undefined ? {} : { suite: failure.suite }),
      ...(failure.file === undefined ? {} : { reportedFile: failure.file }),
    };
    const attribution = attribute(failure, known);
    if (!("file" in attribution)) {
      unattributed.push({ ...details, ...attribution });
    } else if (plan.mode === "SELECTIVE" && plan.skipped.has(attribution.file)) {
      missed.push({ ...details, file: attribution.file });
    } else {
      selected.push({ ...details, file: attribution.file });
    }
  }
  return {
    schemaVersion: 1,
    mode: plan.mode,
    fullFallback: plan.mode === "FULL",
    summary: { failedTests: results.failures.length, missed: missed.length, selected: selected.length, unattributed: unattributed.length },
    missed, selected, unattributed,
  };
}
