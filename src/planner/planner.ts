import type { ImpactResult } from "../repo/impact-types.js";
import type { RepositoryProfile } from "../repo/types.js";
import { planSelectiveTestCommands } from "./test-command.js";
import type { CITaskDefinition, TaskRegistry } from "./task-registry.js";
import type { CIPlanner, CIPlannerInput, ExecutionPlan, PlanEvidence, TaskDecision, TaskStatus } from "./types.js";

const PLAN_VERSION = "5.0.0";

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice((match.index ?? 0) + match[0].length);
  const alternatives = match[1]!.split(",");
  const result: string[] = [];
  for (const alt of alternatives) {
    result.push(...expandBraces(`${prefix}${alt}${suffix}`));
  }
  return result;
}

/**
 * A task input glob as an anchored regex. `**\/` is any number of leading directories, a trailing `/**` is
 * anything below, and any other `**` (`**.js`, a bare `**`) is any run of characters including `/`, as in
 * GitHub's path filters. `*` stays within one segment. Characters that only mean something to a regex
 * (`( ) $ ^ |`) are literal, so route directories like `app/(marketing)` and `routes/$id.tsx` match
 * themselves. `?`, `+` and `[...]` keep their filter meaning.
 */
function regexFrom(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "/" && pattern.startsWith("**", index + 1) && index + 3 === pattern.length) {
      source += "(?:/.*)?";
      index += 2;
    } else if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
      else { source += ".*"; index += 1; }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (/[\\.()$^|]/.test(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`^${source}$`);
}

function matches(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return expandBraces(pattern).some((p) => {
    let regex: RegExp;
    try {
      regex = regexFrom(p);
    } catch {
      // A pattern that is not a valid filter cannot rule a change out: count it as matching, so the
      // task runs rather than the whole plan throwing.
      return true;
    }
    return regex.test(normalized);
  });
}

function matchesAny(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matches(path, p));
}

function toPosix(p: string): string { return p.replace(/\\/g, "/"); }

export class DefaultCIPlanner implements CIPlanner {
  private readonly taskRegistry: TaskRegistry;
  private readonly alwaysRunIds: Set<string>;

  constructor(taskRegistry: TaskRegistry) {
    this.taskRegistry = taskRegistry;
    this.alwaysRunIds = new Set(taskRegistry.alwaysRunTasks().map((t) => t.id));
  }

  plan(input: CIPlannerInput): ExecutionPlan {
    const { delta, impact, profile } = input;
    const changedPaths = delta.files.map((f) => toPosix(f.path));
    const allTestPaths = this.allTestPaths(profile);

    const fallbackRequired = impact.fallbackRequired;
    const fallbackReasons = impact.fallbackReasons;
    const mode = fallbackRequired ? "FULL" : "SELECTIVE";
    const selectedTests = fallbackRequired ? allTestPaths : impact.affectedTests.map((t) => t.path);
    const skippedTests = fallbackRequired ? [] : allTestPaths.filter((p) => !selectedTests.includes(p));
    const tasks = this.buildTasks(fallbackRequired, fallbackReasons, changedPaths, impact, selectedTests, allTestPaths);
    const alwaysRunTasks = tasks.filter((t) => t.status === "ALWAYS_RUN").map((t) => t.id);

    // Phase 01 (2026-08-26): the command is derived from the TARGET repository's own runners and
    // configs (test-command.ts) instead of this repository's `tsx --test` layout.
    //
    // Deliberately kept separate from `mode`. "Which tests does this change require?" and "can DiffCI
    // write a command that runs them here?" are different questions, and a first version of this
    // conflated them - forcing FULL whenever no command could be built, which would have thrown away
    // a correct selection in shadow mode, where nothing is executed at all. The defect being fixed
    // was never that a command was missing; it was that a WRONG one was emitted and looked right. So
    // when the command cannot be constructed, none is emitted and `commandSynthesis` says why. Any
    // caller that intends to EXECUTE a plan must check that field - an empty command list means
    // "DiffCI cannot run this subset here", never "there is nothing to run".
    const commandPlan = fallbackRequired
      ? undefined
      : planSelectiveTestCommands(profile, selectedTests);
    const commandSpecs = commandPlan?.commands ?? [];
    const commandSynthesis: ExecutionPlan["commandSynthesis"] = fallbackRequired
      ? { status: "NOT_APPLICABLE", reason: "full fallback: the repository's own full test command applies" }
      : commandPlan?.refusalReason !== undefined
        ? { status: "UNAVAILABLE", reason: commandPlan.refusalReason }
        : { status: "OK", groups: commandPlan?.groups.map((g) => ({ runnerId: g.runnerId, label: g.label, paths: g.paths })) };

    return {
      version: PLAN_VERSION,
      mode,
      tasks,
      selectedTests,
      skippedTests,
      alwaysRunTasks,
      fallbackReasons,
      evidence: this.collectEvidence(impact),
      safety: {
        // Stage 1B fix (2026-08-21): this previously checked impact.changedFiles[].reasons for
        // "GRAPH_CONFIDENCE_UNSAFE" - a condition that could never be true, since that reason is only
        // ever pushed to impact.riskSignals (a global list), never into any changedFile's own reasons
        // array (see changedFileReasons() in impact.ts, which only ever returns DIRECT_CHANGE/
        // DELETED_FILE_LEGACY_DEPENDENTS/RENAMED_FILE_LEGACY_IDENTITY). This field had silently always
        // reported "COMPLETE" regardless of actual graph confidence - a real, pre-existing display/
        // observability bug discovered while wiring in per-delta confidence refinement, fixed here as
        // part of the same change since it's the same code path. Did not affect actual safety behavior
        // - fallbackRequired/mode below were always correctly gated by the real confidence value.
        graphConfidence: impact.effectiveGraphConfidence,
        impactStatus: impact.analysisStatus,
        fallbackRequired,
      },
      commandSpecs,
      commandSynthesis,
    };
  }

  private allTestPaths(profile: RepositoryProfile): string[] {
    // Real individual test file paths, not the glob patterns in profile.tests (those are
    // aggregate glob+count summaries, e.g. "**/*.test.ts" - comparing them against real
    // file paths elsewhere, as selectedTests/skippedTests do, would never match).
    return Array.from(new Set(profile.testFilePaths)).sort();
  }

  private collectEvidence(impact: ImpactResult): PlanEvidence[] {
    const evidence: PlanEvidence[] = [];
    for (const e of impact.evidence) evidence.push({ reason: e.reason, source: "impact", file: e.affectedFile });
    if (impact.fallbackRequired) {
      for (const reason of impact.fallbackReasons) evidence.push({ reason: "FALLBACK", source: "fallback", file: reason });
    }
    for (const task of this.taskRegistry.alwaysRunTasks()) evidence.push({ reason: "ALWAYS_RUN_POLICY", source: "policy", file: task.id });
    return evidence;
  }

  private buildTasks(fallbackRequired: boolean, fallbackReasons: string[], changedPaths: string[], impact: ImpactResult, selectedTests: string[], allTestPaths: string[]): TaskDecision[] {
    return this.taskRegistry.all().map((task) => {
      const alwaysRun = this.alwaysRunIds.has(task.id);
      let status: TaskStatus;
      let reason: string;
      const triggeredBy: string[] = [];

      if (fallbackRequired) {
        status = alwaysRun ? "ALWAYS_RUN" : "FULL_FALLBACK";
        reason = `Full fallback triggered: ${fallbackReasons.join("; ") || "global risk signal"}`;
      } else if (alwaysRun) {
        status = "ALWAYS_RUN";
        reason = `Always-run policy: ${task.description || task.id}`;
      } else if (this.triggered(task, changedPaths, impact)) {
        status = "RUN";
        reason = `Triggered by changed files matching ${task.id} input patterns`;
        triggeredBy.push(...changedPaths.filter((p) => matchesAny(p, task.inputPatterns)));
      } else if (task.category === "test" && selectedTests.length < allTestPaths.length) {
        status = "SKIP_CANDIDATE";
        reason = "No affected tests matched this task via changed files in current delta";
      } else {
        status = "SKIP_CANDIDATE";
        reason = "No matching changed files and task is not always-run";
      }

      return { id: task.id, command: task.command, category: task.category, status, reason, alwaysRun, triggeredBy, hasTestCommand: task.hasTestCommand };
    });
  }

  private triggered(task: CITaskDefinition, changedPaths: string[], impact: ImpactResult): boolean {
    if (changedPaths.some((p) => matchesAny(p, task.inputPatterns))) return true;
    if (task.globalRiskTriggers) {
      for (const signal of impact.riskSignals) { if (task.globalRiskTriggers.includes(signal.reason)) return true; }
    }
    return false;
  }
}
