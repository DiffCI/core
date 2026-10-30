import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { inferFullCommand } from "./full-command.js";
import { plannedChecks, type PlannedCheck } from "./gate-checks.js";
import { observe } from "./observe.js";
import type { ObservationReport } from "./report.js";
import { executableSelection } from "./verify.js";
import { measureCommand, type CommandMeasurement } from "./verify-savings.js";

/**
 * `diffci gate` in observe mode (2026-10-30, docs/design/pipeline-impact.md, phase 2).
 *
 * WHY. Builds that run a script instead of workflow jobs (DentalPresence's Cloudflare Sandbox build runs
 * `npm run check` and its whole test suite on every staging build, about 19 of 44 build-hours) cannot use
 * per-job `if:` conditions. `diffci gate` replaces that script. Before anything is skipped in a build, the
 * miss rate has to be measured on real builds, so this mode changes nothing about what runs.
 *
 * WHAT IT DOES. Runs every leaf of the gate and the full test command, exactly as the build would, and
 * exits with their result. Alongside, it records what DiffCI would have done for the same commit range:
 * each check's RUN/NARROWED/SKIP decision and the test selection. A miss is a step DiffCI would have
 * skipped or narrowed that failed in full while DiffCI's version passed; those are only rerun when the full
 * step failed, so a passing build pays for nothing but the analysis. `--measure-selected` also runs the
 * narrowed checks and selected tests on passing builds, to measure rather than estimate the saving.
 *
 * DiffCI never decides the build's outcome here: an analysis that fails still runs and reports the full gate.
 */

export const GATE_SCHEMA = "diffci.gate.v1" as const;

export type StepStatus = "passed" | "failed" | "timed_out" | "not_run";

export interface StepRun {
  status: StepStatus;
  wall_ms?: number;
  exit_code?: number | null;
}

export interface GateCheckReport {
  id: string;
  kind: PlannedCheck["kind"];
  /** What DiffCI would have done; UNPLANNED when the change could not be analysed. */
  decision: PlannedCheck["decision"] | "UNPLANNED";
  reason: string;
  command: string;
  narrowed_command?: string;
  full: StepRun;
  narrowed?: StepRun;
  /** The full step failed and DiffCI would have skipped it, or its narrowed run passed. */
  missed?: boolean;
}

export interface GateTestReport {
  command: string;
  full: StepRun & { failing_tests?: string[] };
  selection: "selected" | "full" | "unavailable";
  reason: string;
  tests_selected: number;
  tests_available: number;
  selected_commands?: string[];
  selected?: StepRun;
  missed?: boolean;
}

export interface GateReport {
  schema: typeof GATE_SCHEMA;
  schema_version: "1";
  produced_at: string;
  diffci_version: string;
  mode: "observe";
  range?: { base_sha: string; head_sha: string; source: string };
  analysis: { status: string; reason?: string; mode?: string; fallback_reasons: string[]; duration_ms?: number };
  gate: { status: "passed" | "failed"; wall_ms: number; reason: string };
  checks: GateCheckReport[];
  tests?: GateTestReport;
  summary: {
    /** Every gate step run one after another, as observed. */
    full_ms: number;
    /** Analysis plus the steps DiffCI would have run. */
    diffci_ms: number;
    saved_ms: number;
    /** `measured` when every step DiffCI would have run was timed; `estimated` when narrowed checks count at
     * their full time and selected tests in proportion to the files selected. */
    basis: "measured" | "estimated";
    misses: string[];
  };
}

export interface GateOptions {
  repoPath: string;
  env: Record<string, string | undefined>;
  version: string;
  engineSha?: string;
  baseOverride?: string;
  headOverride?: string;
  /** The build's full test command; defaults to the repository's conventional one (`npm test`). */
  tests?: string;
  /** The build's gate scripts beyond `check`; replaces the scripts CI workflows add. */
  scripts?: readonly string[];
  measureSelected?: boolean;
  timeoutMs: number;
  tailBytes: number;
  /** Injected for tests. */
  run?: (command: string, options: { cwd: string; timeoutMs: number; tailBytes: number }) => CommandMeasurement;
  analyse?: (options: Parameters<typeof observe>[0]) => Promise<ObservationReport>;
}

function stepRun(measurement: CommandMeasurement): StepRun {
  const status: StepStatus = measurement.timedOut ? "timed_out" : measurement.exitCode === 0 && measurement.signal === null ? "passed" : "failed";
  return { status, wall_ms: measurement.wallMs, exit_code: measurement.exitCode };
}

export async function runGate(options: GateOptions): Promise<GateReport> {
  const repoPath = resolve(options.repoPath);
  const run = options.run ?? measureCommand;
  const started = Date.now();
  const remaining = () => Math.max(options.timeoutMs - (Date.now() - started), 0);
  const execute = (command: string): CommandMeasurement => run(command, { cwd: repoPath, timeoutMs: remaining(), tailBytes: options.tailBytes });

  // 1. What DiffCI would do. Never fatal: the full gate runs whatever happens here.
  const temporary = mkdtempSync(join(tmpdir(), "diffci-gate-"));
  let observation: ObservationReport | undefined;
  let analysisError: string | undefined;
  try {
    observation = await (options.analyse ?? observe)({
      repoPath, env: options.env, version: options.version, engineSha: options.engineSha,
      baseOverride: options.baseOverride, headOverride: options.headOverride,
      reportPath: join(temporary, "observation.json"), selectTestPhases: true,
    });
  } catch (error) {
    analysisError = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const range = observation?.commitRange;
  const result = observation?.status === "OBSERVED" ? observation.result : undefined;
  const analysisMs = observation?.timings?.totalMs ?? 0;

  const extraRoots = options.scripts ?? [];
  const full = plannedChecks(repoPath, undefined, { extraRoots });
  const decided = range ? plannedChecks(repoPath, { baseSha: range.baseSha, headSha: range.headSha }, { extraRoots }) : [];
  const decisionOf = new Map(decided.map((check) => [check.id, check]));

  // 2. The full gate, every leaf, continuing past failures so each one is attributed.
  const checks: GateCheckReport[] = full.map((check) => {
    const plan = decisionOf.get(check.id);
    const measured = stepRun(execute(check.command));
    return {
      id: check.id, kind: check.kind,
      decision: plan?.decision ?? "UNPLANNED",
      reason: plan?.reason ?? (analysisError ?? observation?.reason ?? "the change could not be analysed"),
      command: check.command,
      ...(plan?.decision === "NARROWED" ? { narrowed_command: plan.command } : {}),
      full: measured,
    };
  });

  const testCommand = options.tests ?? inferFullCommand(repoPath).command;
  let tests: GateTestReport | undefined;
  if (testCommand) {
    const measurement = execute(testCommand);
    const fullRun = { ...stepRun(measurement), ...(measurement.failingTests?.length ? { failing_tests: measurement.failingTests } : {}) };
    const plan = result ? executableSelection(repoPath, result) : undefined;
    const selection = !plan || !plan.command ? "unavailable" : plan.selection;
    tests = {
      command: testCommand, full: fullRun, selection,
      reason: plan?.reason ?? (analysisError ?? observation?.reason ?? "the change could not be analysed"),
      tests_selected: selection === "selected" ? result?.selectedTests.length ?? 0 : result?.totalTestCount ?? 0,
      tests_available: result?.totalTestCount ?? 0,
      ...(selection === "selected" ? { selected_commands: plan!.commands } : {}),
    };
  }

  // 3. Misses, and optional timing of DiffCI's own versions of the steps. Reruns happen only on failure
  //    unless --measure-selected asks for timings on a passing build.
  for (const check of checks) {
    if (check.full.status === "passed" && !options.measureSelected) continue;
    if (check.decision === "SKIP") { check.missed = check.full.status !== "passed"; continue; }
    if (check.decision !== "NARROWED" || !check.narrowed_command) continue;
    check.narrowed = stepRun(execute(check.narrowed_command));
    if (check.full.status !== "passed") check.missed = check.narrowed.status === "passed";
  }
  if (tests?.selected_commands && (tests.full.status !== "passed" || options.measureSelected)) {
    const runs = tests.selected_commands.map((command) => execute(command));
    const failed = runs.find((measurement) => stepRun(measurement).status !== "passed");
    tests.selected = { ...stepRun(failed ?? runs[runs.length - 1]!), wall_ms: runs.reduce((sum, measurement) => sum + measurement.wallMs, 0) };
    if (tests.full.status !== "passed") tests.missed = tests.selected.status === "passed";
  }

  // 4. Summary. The build's result is the full gate's, never DiffCI's.
  const failedSteps = [...checks.filter((check) => check.full.status !== "passed").map((check) => check.id), ...(tests && tests.full.status !== "passed" ? ["tests"] : [])];
  const fullMs = checks.reduce((sum, check) => sum + (check.full.wall_ms ?? 0), 0) + (tests?.full.wall_ms ?? 0);
  let estimated = false;
  let diffciMs = analysisMs;
  for (const check of checks) {
    if (check.decision === "SKIP") continue;
    if (check.decision === "NARROWED" && check.narrowed?.wall_ms !== undefined) diffciMs += check.narrowed.wall_ms;
    else {
      if (check.decision === "NARROWED") estimated = true;
      diffciMs += check.full.wall_ms ?? 0;
    }
  }
  if (tests) {
    if (tests.selection !== "selected") diffciMs += tests.full.wall_ms ?? 0;
    else if (tests.selected?.wall_ms !== undefined) diffciMs += tests.selected.wall_ms;
    else {
      estimated = true;
      diffciMs += Math.round((tests.full.wall_ms ?? 0) * (tests.tests_available ? tests.tests_selected / tests.tests_available : 1));
    }
  }
  const misses = [...checks.filter((check) => check.missed).map((check) => check.id), ...(tests?.missed ? ["tests"] : [])];

  return {
    schema: GATE_SCHEMA, schema_version: "1", produced_at: new Date().toISOString(), diffci_version: options.version, mode: "observe",
    ...(range ? { range: { base_sha: range.baseSha, head_sha: range.headSha, source: range.source } } : {}),
    analysis: {
      status: analysisError ? "ERROR" : observation?.status ?? "ERROR",
      ...(analysisError ?? observation?.reason ? { reason: analysisError ?? observation?.reason } : {}),
      ...(result?.mode ? { mode: result.mode } : {}),
      fallback_reasons: result?.fallbackReasons ?? [],
      ...(observation?.timings?.totalMs !== undefined ? { duration_ms: observation.timings.totalMs } : {}),
    },
    gate: {
      status: failedSteps.length ? "failed" : "passed",
      wall_ms: Date.now() - started,
      reason: failedSteps.length ? `failed: ${failedSteps.join(", ")}` : testCommand ? "every gate step passed" : "every gate check passed; no test command was found",
    },
    checks,
    ...(tests ? { tests } : {}),
    summary: { full_ms: fullMs, diffci_ms: diffciMs, saved_ms: fullMs - diffciMs, basis: estimated ? "estimated" : "measured", misses },
  };
}

export function gateExitCode(report: GateReport): number {
  return report.gate.status === "passed" ? 0 : 1;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function formatGateSummary(report: GateReport): string {
  const lines = [
    `DiffCI gate (observe): ${report.gate.status.toUpperCase()} - ${report.gate.reason}`,
    ...(report.range ? [`  range: ${report.range.base_sha.slice(0, 12)}..${report.range.head_sha.slice(0, 12)}`] : []),
    `  analysis: ${report.analysis.status}${report.analysis.mode ? ` (${report.analysis.mode})` : ""}${report.analysis.reason ? ` - ${report.analysis.reason}` : ""}`,
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.full.status === "passed" ? "ok  " : "FAIL"} ${check.id} ${seconds(check.full.wall_ms ?? 0)} - DiffCI: ${check.decision}${check.missed ? " (MISSED)" : ""}`);
  }
  if (report.tests) {
    const t = report.tests;
    const scope = t.selection === "selected" ? `${t.tests_selected}/${t.tests_available} test files` : t.selection;
    lines.push(`  ${t.full.status === "passed" ? "ok  " : "FAIL"} tests ${seconds(t.full.wall_ms ?? 0)} - DiffCI: ${scope}${t.missed ? " (MISSED)" : ""}`);
  }
  const s = report.summary;
  lines.push(`  full gate ${seconds(s.full_ms)}, DiffCI ${seconds(s.diffci_ms)} (${s.basis}), would save ${seconds(s.saved_ms)}`);
  lines.push(s.misses.length ? `  MISSES: ${s.misses.join(", ")}` : "  misses: none");
  return lines.join("\n");
}
