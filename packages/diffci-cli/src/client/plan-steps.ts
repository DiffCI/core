import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import type { PlannedCheck } from "./gate-checks.js";
import type { GatePlan } from "./gate.js";

/**
 * `diffci plan --steps` (2026-11-28, DiffCI/core#349, docs/design/pipeline-impact.md phase 2).
 *
 * WHY. DiffCI narrows the tests inside a job, but every job still starts, installs and runs its setup. On
 * DentalPresence a three-file dependency bump ran the full suite, CodeQL, the D1 route suites and the evidence
 * jobs, and the repository ran out of GitHub minutes on 2026-11-08. Skipping or narrowing whole jobs saves
 * far more than narrowing tests inside them.
 *
 * WHAT. Reads each GitHub Actions job and matches every step to a decision DiffCI already makes: a gate check
 * (`npm run lint`: RUN, NARROWED or SKIP, gate-checks.ts) or the test command (selected or full). A job is
 * `skip` when every step that does work is a check or test DiffCI would skip, `narrowed` when none runs in
 * full and at least one is narrowed, and `run` otherwise.
 *
 * GROUND RULES (#349). A step DiffCI does not recognise makes its job run. Security jobs always run. A job
 * another running job needs always runs, because GitHub skips the jobs that need a skipped job. When the
 * change cannot be analysed, every job runs. The default mode is observe: the outputs say what DiffCI would
 * do, and `should_run` stays true for every job until a repository opts into enforce.
 */

export const STEP_PLAN_SCHEMA = "diffci.step-plan.v1" as const;

export type StepDecision = "run" | "narrowed" | "skip";

export interface PlannedStep {
  /** 1-based position in the job, and the step's name or id when it has one. */
  index: number;
  name?: string;
  decision: StepDecision | "setup" | "unrecognised";
  reason: string;
  /** What the step should run instead, when DiffCI narrowed it (absent when it runs as written). */
  narrowed_command?: string;
}

export interface PlannedJob {
  workflow: string;
  job: string;
  /** The job id as a GitHub output name: letters, digits and underscores. */
  key: string;
  decision: StepDecision;
  reason: string;
  /** Observe mode: always true. Enforce: false only when the decision is skip. */
  should_run: boolean;
  steps: PlannedStep[];
}

export interface StepPlan {
  schema: typeof STEP_PLAN_SCHEMA;
  mode: "observe" | "enforce";
  range?: GatePlan["range"];
  analysis: GatePlan["analysis"];
  jobs: PlannedJob[];
}

export interface StepPlanOptions {
  repoPath: string;
  plan: GatePlan;
  mode: "observe" | "enforce";
  /** Only this workflow (`.github/workflows/ci.yml`, or its file name). */
  workflow?: string;
  /** plannedChecks for the range: with `extraRoots`, the package's gate plus those scripts; without, the
   * package's gate plus the check scripts and Python checks CI workflows run. */
  checksFor: (extraRoots?: readonly string[]) => PlannedCheck[];
}

/** Steps that prepare a job and decide nothing about whether its work is needed. */
const SETUP_ACTION = /^(?:actions\/(?:checkout|setup-node|setup-python|cache|upload-artifact)|pnpm\/action-setup|oven-sh\/setup-bun|astral-sh\/setup-uv)@/;
const SETUP_LINE = /^(?:set\s+-[euxo]+(?:\s+pipefail)?|(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i)(?:\s+--?[\w-]+(?:=\S+)?)*|yarn|corepack\s+enable(?:\s+\w+)?|echo\s.*|uv\s+sync(?:\s+--?[\w-]+(?:=\S+)?)*)$/;
/** The step a wired workflow adds to run DiffCI's narrowed command (examples/github-actions-step-plan.yml). */
const NARROWED_STEP = /^\$\{\{\s*needs\.[\w-]+\.outputs\.\w+_step_\d+\s*\}\}$/;
const SCRIPT_LINE = /^(?:npm\s+run(?:-script)?|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([\w:.@/-]+)$/;
const TEST_LINE = /^(?:npm\s+(?:test|t|run\s+test)|pnpm(?:\s+run)?\s+test|yarn(?:\s+run)?\s+test|bun\s+run\s+test)$/;
/** Jobs that always run, whatever changed (#349 ground rule). */
const SECURITY_ACTION = /^(?:github\/codeql-action|ossf\/scorecard-action|actions\/dependency-review-action|aquasecurity\/trivy-action|snyk\/actions|step-security\/harden-runner)\//;
const SECURITY_NAME = /codeql|security|scorecard|dependency-review|audit|secret|trivy|snyk|sast/i;

const rank: Record<StepDecision, number> = { skip: 0, narrowed: 1, run: 2 };

export function outputKey(job: string): string {
  return job.replace(/[^A-Za-z0-9_]/g, "_");
}

function workflowFiles(repoPath: string, only?: string): Array<{ path: string; text: string }> {
  const dir = join(repoPath, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const wanted = only?.replace(/\\/g, "/").replace(/^\.\//, "");
  return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort()
    .filter((name) => !wanted || wanted === name || wanted === `.github/workflows/${name}`)
    .flatMap((name) => {
      try { return [{ path: `.github/workflows/${name}`, text: readFileSync(join(dir, name), "utf8") }]; } catch { return []; }
    });
}

/** The lines a `run:` step executes, or undefined when it needs a shell DiffCI does not model. */
function runLines(run: string): string[] | undefined {
  const lines = run.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  // Continuations, heredocs, expressions and control flow change what a line means on its own.
  if (lines.some((line) => /\\$|<<|\$\{\{|^(?:if|for|while|case|then|else|fi|do|done)\b/.test(line))) return undefined;
  return lines;
}

interface LineDecision { decision: StepDecision; reason: string; command?: string }

export function planSteps(options: StepPlanOptions): StepPlan {
  const { plan } = options;
  const analysed = plan.analysis.status === "OBSERVED";
  // Every check DiffCI plans, for steps that run one as written; and the package's own gate alone, so the
  // leaves a workflow-run script adds can be told apart from the gate's.
  const all = analysed ? options.checksFor() : [];
  const base = analysed ? options.checksFor([]) : [];
  const leafCache = new Map<string, PlannedCheck[] | undefined>();

  /** The planned leaves `npm run <script>` runs, or undefined when DiffCI does not plan that script. */
  const leavesOf = (script: string): PlannedCheck[] | undefined => {
    if (leafCache.has(script)) return leafCache.get(script);
    const own = (checks: PlannedCheck[]) => checks.filter((check) => check.id === script || check.id.startsWith(`${script}[`));
    // The package's gate root (`check`) runs the whole gate; a leaf of it runs itself.
    let leaves = isGateRoot(options.repoPath, script) ? base : own(all);
    if (leaves.length === 0) {
      const known = new Set(base.map((check) => check.id));
      leaves = options.checksFor([script]).filter((check) => !known.has(check.id));
    }
    const result = leaves.length ? leaves : undefined;
    leafCache.set(script, result);
    return result;
  };

  const checkLine = (checks: PlannedCheck[], label: string): LineDecision => {
    if (checks.every((check) => check.decision === "SKIP")) return { decision: "skip", reason: `${label}: ${checks[0]!.reason}` };
    if (checks.every((check) => check.decision !== "RUN")) {
      const kept = checks.filter((check) => check.decision === "NARROWED");
      return { decision: "narrowed", reason: `${label}: ${kept.map((check) => check.reason).join("; ")}`, command: kept.map((check) => check.command).join(" && ") };
    }
    const running = checks.find((check) => check.decision === "RUN")!;
    return { decision: "run", reason: `${label}: ${running.id} runs as written (${running.reason})` };
  };

  const testLine = (line: string): LineDecision => {
    const tests = plan.tests;
    if (tests.selection === "selected" && tests.tests_selected === 0) return { decision: "skip", reason: `${line}: no test is affected by this change` };
    if (tests.selection === "selected" && tests.selected_commands?.length) {
      return { decision: "narrowed", reason: `${line}: ${tests.tests_selected}/${tests.tests_available} test files selected`, command: tests.selected_commands.join(" && ") };
    }
    return { decision: "run", reason: `${line}: ${tests.reason}` };
  };

  const classify = (line: string): LineDecision | "setup" | undefined => {
    if (SETUP_LINE.test(line)) return "setup";
    if (!analysed) return undefined;
    if (TEST_LINE.test(line)) return testLine(line);
    const exact = all.filter((check) => check.command === line);
    if (exact.length) return checkLine(exact, line);
    const script = SCRIPT_LINE.exec(line)?.[1];
    if (script === "test") return testLine(line);
    const leaves = script ? leavesOf(script) : undefined;
    return leaves ? checkLine(leaves, line) : undefined;
  };

  const jobs: PlannedJob[] = [];
  for (const file of workflowFiles(options.repoPath, options.workflow)) {
    let parsed: { jobs?: Record<string, unknown> } | null;
    try { parsed = parse(file.text) as typeof parsed; } catch { continue; }
    const declared = parsed?.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};
    const fileJobs: PlannedJob[] = [];
    const needs = new Map<string, string[]>();
    for (const [id, value] of Object.entries(declared)) {
      const job = (value && typeof value === "object" ? value : {}) as { name?: unknown; uses?: unknown; steps?: unknown; needs?: unknown };
      needs.set(id, typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs.filter((n): n is string => typeof n === "string") : []);
      const steps: PlannedStep[] = [];
      let decision: StepDecision = "skip";
      let reason = "";
      const force = (why: string) => { decision = "run"; reason ||= why; };
      if (!analysed) force(`the change could not be analysed (${plan.analysis.reason ?? plan.analysis.status}), so every job runs`);
      if (typeof job.uses === "string") force(`calls the reusable workflow ${job.uses}, which DiffCI does not read`);
      const rawSteps = Array.isArray(job.steps) ? job.steps : [];
      if (rawSteps.length === 0 && typeof job.uses !== "string") force("declares no steps DiffCI can read");
      const security = SECURITY_NAME.test(id) || (typeof job.name === "string" && SECURITY_NAME.test(job.name));
      let work = 0;
      rawSteps.forEach((raw, i) => {
        const step = (raw && typeof raw === "object" ? raw : {}) as { name?: unknown; id?: unknown; uses?: unknown; run?: unknown };
        const name = typeof step.name === "string" ? step.name : typeof step.id === "string" ? step.id : undefined;
        const planned = (entry: Omit<PlannedStep, "index" | "name">): void => { steps.push({ index: i + 1, ...(name ? { name } : {}), ...entry }); };
        if (typeof step.uses === "string") {
          if (SECURITY_ACTION.test(step.uses)) { planned({ decision: "run", reason: `security action ${step.uses} always runs` }); force(`runs the security action ${step.uses}, and security jobs always run`); return; }
          if (SETUP_ACTION.test(step.uses)) { planned({ decision: "setup", reason: `${step.uses} prepares the job` }); return; }
          planned({ decision: "unrecognised", reason: `DiffCI does not know what ${step.uses} does` });
          force(`step ${i + 1} uses ${step.uses}, which DiffCI does not recognise`);
          return;
        }
        if (typeof step.run !== "string") { planned({ decision: "unrecognised", reason: "neither uses nor run" }); force(`step ${i + 1} has neither uses nor run`); return; }
        if (NARROWED_STEP.test(step.run.trim())) { planned({ decision: "setup", reason: "runs DiffCI's narrowed command for an earlier step" }); return; }
        const lines = runLines(step.run);
        if (!lines) { planned({ decision: "unrecognised", reason: "the script needs a shell DiffCI does not model (continuations, expressions or control flow)" }); force(`step ${i + 1} runs a script DiffCI does not model`); return; }
        const decided: LineDecision[] = [];
        const replaced: string[] = [];
        for (const line of lines) {
          const verdict = classify(line);
          if (verdict === undefined) {
            planned({ decision: "unrecognised", reason: `DiffCI does not plan \`${line}\`` });
            force(`step ${i + 1} runs \`${line}\`, which DiffCI does not plan`);
            return;
          }
          if (verdict === "setup") { replaced.push(line); continue; }
          decided.push(verdict);
          if (verdict.decision === "narrowed") replaced.push(verdict.command!);
          else if (verdict.decision === "run") replaced.push(line);
        }
        if (decided.length === 0) { planned({ decision: "setup", reason: "installs or prints only" }); return; }
        work += 1;
        const stepDecision = decided.reduce<StepDecision>((worst, line) => (rank[line.decision] > rank[worst] ? line.decision : worst), "skip");
        planned({
          decision: stepDecision,
          reason: decided.map((line) => line.reason).join("; "),
          ...(stepDecision === "narrowed" ? { narrowed_command: replaced.join("\n") } : {}),
        });
        if (rank[stepDecision] > rank[decision]) decision = stepDecision;
        if (stepDecision !== "skip" && !reason) reason = decided.find((line) => line.decision === stepDecision)!.reason;
      });
      if (security) force("security jobs always run");
      if (work === 0 && (decision as StepDecision) !== "run") force("no step does work DiffCI plans");
      if (!reason) reason = "every check and test step is skipped for this change";
      fileJobs.push({ workflow: file.path, job: id, key: outputKey(id), decision, reason, should_run: true, steps });
    }
    // GitHub skips every job that needs a skipped job, so a job a running job needs must run (to a fixpoint).
    for (let changed = true; changed;) {
      changed = false;
      for (const job of fileJobs) {
        if (job.decision === "run") continue;
        const dependent = fileJobs.find((other) => other.decision !== "skip" && needs.get(other.job)?.includes(job.job));
        if (dependent && job.decision === "skip") {
          job.decision = "run";
          job.reason = `${dependent.job} needs it, and GitHub skips the jobs that need a skipped job`;
          changed = true;
        }
      }
    }
    jobs.push(...fileJobs);
  }
  for (const job of jobs) job.should_run = options.mode === "observe" || job.decision !== "skip";
  return { schema: STEP_PLAN_SCHEMA, mode: options.mode, ...(plan.range ? { range: plan.range } : {}), analysis: plan.analysis, jobs };
}

function isGateRoot(repoPath: string, script: string): boolean {
  try {
    const scripts = (JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return script === (scripts["check"] !== undefined ? "check" : scripts["validate"] !== undefined ? "validate" : undefined);
  } catch { return false; }
}

/**
 * The GitHub Actions output lines (`name=value`, multi-line values in heredoc form). Per job: `<key>` is the
 * decision and `<key>_should_run` the condition to use in `if:`; per narrowed step, `<key>_step_<n>` holds the
 * command to run. In observe mode a narrowed step's output is left out, so `run:` falls back to the original.
 */
export function githubOutput(plan: StepPlan): string {
  const lines: string[] = [`diffci_mode=${plan.mode}`, `diffci_analysis=${plan.analysis.status}`];
  const seen = new Set<string>();
  for (const job of plan.jobs) {
    if (seen.has(job.key)) continue; // The first workflow's job wins; pass --workflow to choose.
    seen.add(job.key);
    lines.push(`${job.key}=${job.decision}`, `${job.key}_should_run=${job.should_run}`);
    if (plan.mode !== "enforce" || job.decision === "skip") continue;
    for (const step of job.steps) {
      if (!step.narrowed_command) continue;
      const delimiter = `DIFFCI_EOF_${job.key}_${step.index}`;
      lines.push(`${job.key}_step_${step.index}<<${delimiter}`, step.narrowed_command, delimiter);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** One line per job, for a person reading the plan step's log. */
export function formatStepPlan(plan: StepPlan): string {
  const lines = [`DiffCI step plan (${plan.mode}${plan.mode === "observe" ? ": every job still runs" : ""}):`];
  for (const job of plan.jobs) lines.push(`  ${job.workflow}#${job.job}: ${job.decision} - ${job.reason}`);
  if (plan.jobs.length === 0) lines.push("  no GitHub Actions jobs found");
  return lines.join("\n");
}
