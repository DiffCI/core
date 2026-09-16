// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage 2C measurement-pipeline repair (2026-08-21, docs/research/2026-08-21-stage2c-*.md). Root cause:
 * inferCategory() (workflow-parser.ts) only ever looked at a job's `name:` field (or its YAML key) and
 * its steps' `name:` fields - never the actual `run:` command text, never package.json script
 * resolution. A job named "check" (DiffCI.com's own CI) or "ci" (unjs/defu's) that runs
 * `npm run typecheck && npm run test` matches none of inferCategory()'s keywords and falls through to
 * the "validation" default - so a REAL test failure inside it is silently excluded from
 * relevantFailuresObserved/Evaluable by filterToTestCategoryTaskIds, even though the job's own
 * GitHub-reported failure was captured correctly. Confirmed live on Stage 2B (docs/research/2026-08-21-
 * shadow-source-integrity-fix.md's sibling report) and confirmed structurally on 3 of 5 enrolled
 * repositories by direct inspection of their real workflow files, not just DiffCI.com's - a general
 * classifier weakness, not a dogfooding-only quirk.
 *
 * Deliberately NOT a change to inferCategory()'s output or TaskCategory itself - that field is read by
 * planner-adjacent logic elsewhere (risk triggers, always-run rules in
 * src/research/baseline/registry.ts) that this repair must not touch (Stage 2C explicitly scopes this to
 * the observer/evaluator, not the planner). Instead: a SEPARATE, additive signal
 * (ParsedWorkflowTask.hasTestCommand / CITaskDefinition.hasTestCommand / TaskDecision.hasTestCommand)
 * computed independently from real `run:` command text (+ one level of package.json script resolution),
 * consumed ONLY by evidence-collector.ts's filterToTestCategoryTaskIds - `category` itself is completely
 * unchanged.
 *
 * Priority order (per the task's explicit ask, cheapest/most-precise signal first):
 *   1. Explicit test-related job/step names - already handled by inferCategory(), untouched here.
 *   2. Actual commands recognized as real test-runner invocations (this module, isTestRunnerCommand).
 *   3. package.json script resolution, one level (this module, resolveScriptCommands) - so
 *      `run: npm run check` where package.json's "check" script is "tsc --noEmit && npm run test"
 *      is recognized via its resolved text, not just the literal `run:` line.
 *   4. Job/workflow naming - same as #1, no separate handling needed.
 *   5. Conservative fallback: no signal fires -> hasTestCommand stays false. Never guessed.
 *
 * Known, deliberately NOT hidden limitation (Stage 2C Part 3): a single CI job that bundles multiple
 * kinds of work (e.g. "typecheck && test", or unjs/h3's "lint && typecheck && build && vitest") gets ONE
 * hasTestCommand flag for the WHOLE job - DiffCI's current one-task-per-job model cannot attribute a
 * failure to specifically the test portion vs. the rest of a compound job. A failure anywhere in a
 * hasTestCommand=true job is counted as a potential test-relevant failure, which is coarser than test-
 * level attribution but is the SAME coarseness the existing keyword-based category already had for any
 * job whose name happens to contain "test" (e.g. unjs/h3's "tests" job, which also bundles lint/build) -
 * this repair makes previously-invisible compound jobs behave consistently with already-visible ones,
 * not a new category of risk.
 */

/** Recognized test-runner invocations, matched as substrings against a step's `run:` command text (or a
 * resolved package.json script's definition). Deliberately conservative and explicit - no fuzzy/regex
 * guessing beyond what's listed, so this can only ever ADD detection for real, recognizable test
 * commands, never invent one. */
const TEST_COMMAND_PATTERNS: RegExp[] = [
  /\bnpm\s+test\b/,
  /\bnpm\s+run\s+test(?::\S+)?\b/,
  /\bpnpm\s+(?:run\s+)?test(?::\S+)?\b/,
  /\byarn\s+(?:run\s+)?test(?::\S+)?\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bnode\s+--test\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bmocha\b/,
  /\bava\b/,
];

export function isTestRunnerCommand(text: string): boolean {
  return TEST_COMMAND_PATTERNS.some((re) => re.test(text));
}

/** Matches `npm run <script>`, `pnpm <script>` / `pnpm run <script>`, `yarn <script>` / `yarn run
 * <script>` - the package-manager invocation forms that name a package.json script by its key, so its
 * REAL definition can be looked up and inspected too (one level - a script that itself invokes another
 * `npm run` is not followed further, to keep this bounded and simple to reason about). */
const SCRIPT_INVOCATION_PATTERN = /\b(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+([\w:.-]+)/g;

/** Returns the resolved definitions of every package.json script this command line appears to invoke by
 * name, for the caller to also scan with isTestRunnerCommand - e.g. `run: npm run check` with
 * scripts.check = "npm run typecheck && npm run test" resolves to ["npm run typecheck && npm run test"],
 * whose text itself contains "npm run test". Scripts that aren't found in `scripts` are silently skipped
 * (not every `npm run X` names a package.json script - e.g. corepack/global-tool invocations). */
export function resolveScriptCommands(runLine: string, scripts: Record<string, string>): string[] {
  const resolved: string[] = [];
  for (const match of runLine.matchAll(SCRIPT_INVOCATION_PATTERN)) {
    const scriptName = match[1];
    if (scriptName && scripts[scriptName]) resolved.push(scripts[scriptName]);
  }
  return resolved;
}

/** The full per-task decision: does this job/task's real `run:` command text (directly, or through one
 * level of package.json script resolution) contain a recognized test-runner invocation? `runLines` is
 * every step's `run:` text for the job (multi-line steps included verbatim). */
export function detectTestCommand(runLines: string[], scripts: Record<string, string>): boolean {
  for (const line of runLines) {
    if (isTestRunnerCommand(line)) return true;
    for (const resolved of resolveScriptCommands(line, scripts)) {
      if (isTestRunnerCommand(resolved)) return true;
    }
  }
  return false;
}
