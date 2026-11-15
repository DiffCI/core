#!/usr/bin/env node
/**
 * `diffci` - the client-side command.
 *
 * `observe` and the GitHub Action remain observation-only. `check` measures a full command and a
 * selected command when both can be inferred; it never changes what required CI executes.
 *
 * Sending is opt-in and off unless both an API URL and a token are supplied (Phase 03). Without them
 * the observer is exactly what Phase 02 shipped: a local analysis whose output never leaves the runner.
 *
 * Commands:
 *   init               seed a repository with AI-agent instructions for using DiffCI
 *   mcp                run the stdio MCP server
 *   verify             fail-closed verification of a working-tree snapshot or commit range
 *   watch              verify changes after each save
 *   agent-stop         verify changes when an AI agent finishes a turn
 *   telemetry          configure anonymous usage reporting
 *   gate               run a build's whole gate and record what DiffCI would have skipped (observe)
 *   check              analysis plus automatic paired runtime measurement
 *   plan               print Core's advisory JSON plan for a commit range (the input check-plan reads)
 *   check-plan         compare a saved test selection with one full-suite JUnit result
 *   red-builds         count a repository's red PR builds a check before the push could have prevented
 *   observe            analyse the checkout and write an observation report
 *   verify-savings     run a paired full-versus-selected timing check
 *   pilot              run observation and verification savings
 *   pilot-packet       generate a shareable compatibility packet
 *   validate-specs     block conflicting same-turn change specifications
 *   verify-workflow    check that a DiffCI job in this repository's workflows cannot affect other jobs
 *   enforce-misses     after a full run on main, find failures enforce mode would have skipped
 *   coverage           build a test coverage map
 *   outcomes           summarize previous verification outcomes
 *   version            print the observer version
 *
 * Exit codes: `observe` exits 0 even when it refuses or errors, because a broken observer must not
 * fail somebody's build; the status is in the report and in the printed summary. `--fail-on-error`
 * opts out of that, for operators running it deliberately. The one exception is exit 2, for a
 * misconfigured invocation that would itself break the byte-identical guarantee (a report path inside
 * the observed checkout) - nothing was observed, and the caller has to change the call. `verify-workflow`
 * exits 1 on a BLOCKING finding - it is a pre-install check run by a human, not a step inside a build.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { observe, isInsideRepository } from "./observe.js";
import { resolveObservationAgent } from "./agent-identity.js";
import { inferFullCommand, inferComparableSelectedCommand, inferWorkspaceComparison } from "./full-command.js";
import { addDiffciPackageScripts, detectPackageManager, installDiffci, type SupportedPackageManager } from "./install.js";
import { hookCommand, installPrePushHook, isGitRepository } from "./hook.js";
import { AGENT_HOOK_TIMEOUT_SECONDS, ignoredWrites, MCP_CONFIG_PATHS, SKILL_PATHS, writeAgentStopHook, writeMcpConfig, writeSkill } from "./agent-setup.js";
import type { ObservationReport, WorkflowFinding } from "./report.js";
import { submitObservation } from "./submit.js";
import { configureGraphCache } from "./shared-graph-cache.js";
import { GraphCache } from "@diffci.com/core/cache/graph-cache";
import { githubDeliveryWarning } from "./delivery-warning.js";
import { formatJobSummary } from "./job-summary.js";
import { configureTelemetry, readTelemetryPreference, recordUsage, telemetryNotice } from "./telemetry.js";
import { formatFeedbackPrompt, markFeedbackPromptShown, shouldShowFeedbackPrompt } from "./feedback-prompt.js";
import { detectSpecificationConflicts, readSpecificationFile } from "./spec-conflicts.js";
import { formatVerificationSummary, verificationExitCode, verifyChanged, verifyRange, type VerificationReport } from "./verify.js";
import { startWatch } from "./watch.js";
import { captureWorkingTreeSnapshot } from "./working-tree.js";
import { decideStop, HOOK_AGENTS, maxAttempts, parseStopPayload, sessionAttempts, stopRepoPath, type HookAgent } from "./agent-stop.js";
import { formatGateSummary, gateExitCode, planGate, runGate } from "./gate.js";
import { formatGrowthPrompt, formatVerifySavingsSummary, measureCommand, runVerifySavings, writeVerifySavingsReport, type VerifySavingsOptions } from "./verify-savings.js";
import { auditEnforceWorkflows, auditWorkflows, isNonInterfering } from "./workflow-guard.js";
import { renderPilotPacket } from "./pilot-packet.js";
import { observerIdentity } from "./package-identity.js";
import { buildPilotWorkflow, diffciVerificationWorkflow, diffciWorkflow } from "./workflow-templates.js";
import { buildMissReport, formatMissReportMarkdown, parseJunit, type MissReport } from "./enforce-misses.js";
import { appendOutcome, formatOutcomeSummary, outcomeLogPath, readOutcomes, summarizeOutcomes } from "./outcome-log.js";
import { checkPlan } from "./check-plan.js";
import { runRedBuildsCommand } from "./red-builds.js";
import { buildCoverageMap, formatCoverageRun } from "./coverage-map.js";
import { confidenceCurve, formatConfidenceCurve } from "./test-ranking.js";
import { parseShard, readTimings, timingsFromOutcomes, type TimingsFile } from "./test-shards.js";
import {
  findReceipt,
  findWindowStart,
  inferRerunArgs,
  mergedPullRequests,
  MISS_REPORT_FILE,
  rerunFailingFiles,
  spawnRunner,
  type CollectOptions,
} from "./enforce-misses-collect.js";

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) {
      command ??= token;
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

const CHECK_PLAN_MAX_INPUT_BYTES = 16 * 1024 * 1024;

function readCheckPlanInput(path: string): string {
  // Nonblocking open prevents a named pipe from hanging before the regular-file check. The capped
  // read also preserves the limit if a regular file grows after fstat.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error(`Input must be a regular file: ${path}`);
    if (info.size > CHECK_PLAN_MAX_INPUT_BYTES) throw new Error(`Input exceeds the 16 MiB limit: ${path}`);
    const bytes = Buffer.allocUnsafe(Math.min(info.size, CHECK_PLAN_MAX_INPUT_BYTES) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > CHECK_PLAN_MAX_INPUT_BYTES) throw new Error(`Input exceeds the 16 MiB limit: ${path}`);
    if (length > info.size) throw new Error(`Input grew while being read: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(descriptor);
  }
}

const PLAN_USAGE = "Usage: diffci plan --base <commit> [--head HEAD] [--repo <clean-checkout>]\nPrints Core's advisory JSON plan, the input check-plan reads. Accepts --flag=value. Does not run, skip or cancel tests.\nCounts the run with the repository name (see diffci telemetry); DO_NOT_TRACK=1 stops counting.";

/** Same output and exit codes as Core's own `plan` command, so saved plans stay interchangeable. */
async function runPlanCommand(args: readonly string[]): Promise<number> {
  let repoPath: string | undefined;
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      console.log(PLAN_USAGE);
      return 0;
    }
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      const equals = token.indexOf("=");
      const flag = equals < 0 ? token : token.slice(0, equals);
      if (!["--repo", "--base", "--head"].includes(flag)) throw new Error(`Unsupported plan argument: ${flag}`);
      if (values.has(flag)) throw new Error(`Repeated plan argument: ${flag}`);
      const value = equals < 0 ? args[++index] : token.slice(equals + 1);
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      values.set(flag, value);
    }
    const base = values.get("--base");
    if (!base) throw new Error("Expected: diffci plan --base <commit> [--head HEAD] [--repo <path>]");
    const { analyzeCheckout } = await import("@diffci.com/core/analyze");
    repoPath = values.get("--repo") ?? process.cwd();
    const plan = await analyzeCheckout({ repoPath, base, head: values.get("--head") ?? "HEAD" });
    console.log(JSON.stringify(plan, null, 2));
    await recordUsage("plan", plan.plan.mode === "SELECTIVE" ? "selective" : "full", observerIdentity().version, {}, process.env, repoPath);
    return 0;
  } catch (error: unknown) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), recommendation: "RUN_FULL_CI" }));
    if (repoPath !== undefined) await recordUsage("plan", "error", observerIdentity().version, {}, process.env, repoPath);
    return 1;
  }
}

function runCheckPlanCommand(args: readonly string[]): number {
  try {
    const files = new Map<string, string>();
    if (args.length === 1 && args[0] === "--help") {
      console.log("Usage: diffci check-plan --plan <file> --results <file> [--base-results <file>] [--root <reporter-root>] [--repo <checkout-root>] [--base-repo <base-checkout-root>]\nAccepts --flag=value. Without base results, skipped failures are possibleMisses. Exit 1: missed, possibleMisses or unattributed; exit 2: invalid input.");
      return 0;
    }
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      const equals = token.indexOf("=");
      const flag = equals < 0 ? token : token.slice(0, equals);
      if (!["--plan", "--results", "--base-results", "--root", "--repo", "--base-repo"].includes(flag)) throw new Error(`Unsupported check-plan argument: ${flag}`);
      if (files.has(flag)) throw new Error(`Repeated check-plan argument: ${flag}`);
      const value = equals < 0 ? args[++index] : token.slice(equals + 1);
      if (!value || value.startsWith("--")) throw new Error(`Missing file path for ${flag}`);
      files.set(flag, value);
    }
    const planPath = files.get("--plan");
    const resultsPath = files.get("--results");
    if (!planPath || !resultsPath) throw new Error("check-plan requires --plan <file> and --results <file>");
    if (files.has("--base-repo") && !files.has("--base-results")) throw new Error("--base-repo requires --base-results");
    const plan: unknown = JSON.parse(readCheckPlanInput(planPath));
    const basePath = files.get("--base-results");
    const report = checkPlan(plan, readCheckPlanInput(resultsPath), {
      root: files.get("--root"), repoRoot: resolve(files.get("--repo") ?? process.cwd()),
      baseRepoRoot: files.has("--base-repo") ? resolve(files.get("--base-repo")!) : undefined,
      baseResults: basePath === undefined ? undefined : readCheckPlanInput(basePath),
    });
    console.log(JSON.stringify(report));
    return report.summary.missed > 0 || report.summary.possibleMisses > 0 || report.summary.unattributed > 0 ? 1 : 0;
  } catch (error: unknown) {
    console.error(JSON.stringify({ schemaVersion: 1, error: error instanceof Error ? error.message : "Invalid check-plan input" }));
    return 2;
  }
}

function defaultReportPath(env: NodeJS.ProcessEnv): string {
  // RUNNER_TEMP is outside GITHUB_WORKSPACE on every GitHub-hosted runner, which is the property that
  // matters: the report cannot become an untracked file in the repository being observed.
  const base = env.RUNNER_TEMP && existsSync(env.RUNNER_TEMP) ? env.RUNNER_TEMP : tmpdir();
  const stamp = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}` : String(Date.now());
  return join(base, `diffci-observation-${stamp}.json`);
}

// Quoting the scoped package keeps the same command valid in POSIX shells, cmd.exe, and
// PowerShell, where an unquoted leading `@` is parsed as the splatting operator.
const PUBLIC_AGENT_DEFAULT_COMMAND = 'npx "@diffci.com/diffci@latest" verify --changed --json';

function agentInstructions(command: string): string {
  return `# DiffCI Agent Instructions

Use DiffCI as the default CI/CD validation lens before proposing, committing, or opening pull requests.

Default command:

\`\`\`bash
${command}
\`\`\`

Use it instead of choosing test files yourself and instead of re-running the full suite:

- Run it once after each change and before every commit. Do not pick individual test files to run instead; a hand-picked set misses tests that depend on your change through imports, fixtures and scripts.
- Do not run the full test suite to be safe. DiffCI already falls back to the full suite when it cannot prove a smaller set is enough, and says why in \`reason\`.
- When the MCP server is available, \`diffci_select_tests\` returns the one exact \`command\` to run; run that command as given.

What this does:

- snapshots staged, unstaged, and non-ignored untracked changes;
- selects and runs the minimum executable test verification, broadening to the full test command when uncertain;
- exits zero only when the exact snapshot passes and its files remain unchanged during verification;
- emits a versioned machine-readable receipt and sends nothing.

New files the run writes are listed in the receipt (snapshot.written_during_verification) and do not block it;
consider adding them to .gitignore. If verification changes existing files, review those changes and rerun DiffCI
so the new snapshot is verified.
If the repository has the DiffCI pre-push hook (\`diffci init\` installs it), a push verifies the pushed commits again; do not bypass it with \`--no-verify\` unless the user asks.
Use \`observe --no-send\` when analysis without test execution is needed.

Do not propose, commit, push, or deploy when \`safe_to_continue\` is false. If DiffCI is blocked, run the repository's normal required verification and report the blocker; required project CI remains authoritative.
`;
}

function cursorRule(command: string): string {
  return `---
description: Use DiffCI as the default CI/CD validation lens
alwaysApply: true
---

Before proposing, committing, or opening pull requests, run:

\`\`\`bash
${command}
\`\`\`

DiffCI verify snapshots staged, unstaged, and untracked changes, runs selected or conservative full-fallback verification, and succeeds only when the exact snapshot passes. It sends nothing. If verification changes generated files, review them and rerun. Required project CI remains authoritative.
`;
}

function githubCopilotInstructions(command: string): string {
  return `# Repository CI/CD Validation

Use DiffCI as the default change-aware CI/CD validation lens:

\`\`\`bash
${command}
\`\`\`

DiffCI verify binds selected or conservative full-fallback verification to the current working-tree snapshot. Do not continue when safe_to_continue is false. It sends nothing; required repository checks remain authoritative.
`;
}

function diffciConfig(command: string): string {
  return `{
  "$schema": "https://diffci.com/schemas/diffci.config.schema.json",
  "agentDefaultCommand": ${JSON.stringify(command)},
  "mode": "verify-changed",
  "sendReports": false
}
`;
}

const MANAGED_INSTRUCTIONS_BEGIN = "<!-- diffci:managed:start -->";
const MANAGED_INSTRUCTIONS_END = "<!-- diffci:managed:end -->";

function managedInstructions(content: string): string {
  return `${MANAGED_INSTRUCTIONS_BEGIN}\n${content.trim()}\n${MANAGED_INSTRUCTIONS_END}\n`;
}

function writeInitFile(repoPath: string, relativePath: string, content: string, force: boolean): string {
  const absolutePath = join(repoPath, relativePath);
  const existed = existsSync(absolutePath);
  if (existed && !force) return `kept ${relativePath} (already exists)`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  return `${existed ? "overwrote" : "wrote"} ${relativePath}`;
}

function writeManagedInstructionsFile(repoPath: string, relativePath: string, content: string): string {
  const absolutePath = join(repoPath, relativePath);
  const block = managedInstructions(content);
  mkdirSync(dirname(absolutePath), { recursive: true });
  if (!existsSync(absolutePath)) {
    writeFileSync(absolutePath, block, "utf8");
    return `wrote ${relativePath}`;
  }

  const existing = readFileSync(absolutePath, "utf8");
  const start = existing.indexOf(MANAGED_INSTRUCTIONS_BEGIN);
  const end = existing.indexOf(MANAGED_INSTRUCTIONS_END);
  let next: string;
  if (start >= 0 && end >= start) {
    const after = end + MANAGED_INSTRUCTIONS_END.length;
    next = `${existing.slice(0, start)}${block.trimEnd()}${existing.slice(after)}`;
    if (existing.endsWith("\n") && !next.endsWith("\n")) next += "\n";
  } else if (existing.trimStart().startsWith("# DiffCI Agent Instructions")) {
    // Files generated by DiffCI before managed markers were introduced were dedicated DiffCI files.
    next = block;
  } else {
    next = `${existing.trimEnd()}\n\n${block}`;
  }
  if (next === existing) return `kept ${relativePath} (managed section current)`;
  writeFileSync(absolutePath, next, "utf8");
  return `updated ${relativePath} (DiffCI managed section)`;
}

function writeDiffciConfig(repoPath: string, force: boolean, command: string): string {
  const relativePath = "diffci.config.json";
  const absolutePath = join(repoPath, relativePath);
  const generated = diffciConfig(command);
  if (!existsSync(absolutePath)) return writeInitFile(repoPath, relativePath, generated, false);
  try {
    const existing = JSON.parse(readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
    if (existing.$schema === "https://diffci.com/schemas/diffci.config.schema.json") {
      existing.agentDefaultCommand = command;
      existing.mode = "verify-changed";
      if (existing.sendReports === undefined) existing.sendReports = false;
      const next = `${JSON.stringify(existing, null, 2)}\n`;
      if (next === readFileSync(absolutePath, "utf8")) return `kept ${relativePath} (current)`;
      writeFileSync(absolutePath, next, "utf8");
      return `updated ${relativePath}`;
    }
  } catch {
    // An unrelated or invalid existing file is preserved unless the caller explicitly asked to force.
  }
  return writeInitFile(repoPath, relativePath, generated, force);
}

function installedDiffciManager(repoPath: string): SupportedPackageManager | undefined {
  const packagePath = join(repoPath, "package.json");
  if (!existsSync(packagePath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const installed = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]
      .some((dependencies) => dependencies && typeof dependencies["@diffci.com/diffci"] === "string");
    return installed ? detectPackageManager(repoPath) : undefined;
  } catch {
    return undefined;
  }
}

function runInit(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const repoPath = resolve(typeof flags.repo === "string" ? flags.repo : env.GITHUB_WORKSPACE ?? process.cwd());
  const force = flags.force === true;
  const includeWorkflow = flags.workflow === true;
  const includeVerificationWorkflow = flags["verification-workflow"] === true;
  const identity = observerIdentity();
  let installed: string | undefined;
  let manager = installedDiffciManager(repoPath);
  if (flags.install === true) {
    const { plan, result } = installDiffci(repoPath, identity.version);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `${plan.manager} exited with status ${result.status ?? "unknown"}`;
      throw new Error(`could not install ${plan.packageSpec}: ${detail}`);
    }
    const scripts = addDiffciPackageScripts(repoPath);
    manager = plan.manager;
    installed = `installed ${plan.packageSpec} as an exact dev dependency with ${plan.manager}`;
    if (scripts.added.length > 0) installed += `; added package scripts ${scripts.added.join(", ")}`;
    if (scripts.kept.length > 0) installed += `; kept existing package scripts ${scripts.kept.join(", ")}`;
  } else if (manager) {
    const scripts = addDiffciPackageScripts(repoPath);
    installed = `found the existing exact or ranged @diffci.com/diffci dependency with ${manager}`;
    if (scripts.added.length > 0) installed += `; added package scripts ${scripts.added.join(", ")}`;
    if (scripts.kept.length > 0) installed += `; kept existing package scripts ${scripts.kept.join(", ")}`;
  }

  const agentCommand = manager ? `${manager} run diffci:verify` : PUBLIC_AGENT_DEFAULT_COMMAND;
  const instructions = agentInstructions(agentCommand);
  const writes = [
    writeManagedInstructionsFile(repoPath, "AGENTS.md", instructions),
    writeManagedInstructionsFile(repoPath, "CLAUDE.md", instructions),
    writeInitFile(repoPath, ".cursor/rules/diffci.mdc", cursorRule(agentCommand), force),
    writeManagedInstructionsFile(repoPath, ".github/copilot-instructions.md", githubCopilotInstructions(agentCommand)),
    writeDiffciConfig(repoPath, force, agentCommand),
  ];
  if (includeWorkflow) writes.push(writeInitFile(repoPath, ".github/workflows/diffci.yml", diffciWorkflow(identity.version), force));
  if (includeVerificationWorkflow) {
    writes.push(writeInitFile(repoPath, ".github/workflows/diffci-verify.yml", diffciVerificationWorkflow(identity.version), force));
  }
  // The hook, MCP server and skill are on by default so an agent meets DiffCI without being told to.
  const skipped: string[] = [];
  if (flags["no-mcp"] === true) skipped.push("skipped the MCP server configs (--no-mcp)");
  else for (const path of MCP_CONFIG_PATHS) writes.push(writeMcpConfig(repoPath, path, identity.version, force));
  if (flags["no-skill"] === true) skipped.push("skipped the diffci-verify skills (--no-skill)");
  else for (const path of SKILL_PATHS) writes.push(writeSkill(repoPath, force, path));
  if (flags["no-agent-hooks"] === true) skipped.push("skipped the agent stop hooks (--no-agent-hooks)");
  else for (const agent of HOOK_AGENTS) writes.push(writeAgentStopHook(repoPath, agent, hookCommand(manager, identity.version)));
  if (flags["no-hook"] === true) skipped.push("skipped the pre-push hook (--no-hook)");
  else if (!isGitRepository(repoPath)) skipped.push("skipped the pre-push hook (not a Git repository; rerun init after git init)");
  else writes.push(installPrePushHook(repoPath, hookCommand(manager, identity.version), force));

  console.log(`DiffCI initialized for AI coding agents in ${repoPath}`);
  for (const write of writes) console.log(`  ${write}`);
  if (installed) console.log(`  ${installed}`);
  else console.log("  skipped package installation (pass --install to add an exact dev dependency)");
  for (const line of skipped) console.log(`  ${line}`);
  const ignored = ignoredWrites(repoPath, writes);
  if (ignored.length > 0) {
    console.log(`\nWarning: .gitignore keeps ${ignored.length === 1 ? "this file" : "these files"} out of commits, so other checkouts and agent sessions will not get ${ignored.length === 1 ? "it" : "them"}:`);
    for (const path of ignored) console.log(`  ${path}`);
    console.log("Add an exception (for example !/.claude/skills/ after /.claude/*) or commit with git add -f.");
  }
  if (!includeWorkflow) console.log("  skipped .github/workflows/diffci.yml (pass --workflow to add it)");
  if (!includeVerificationWorkflow) console.log("  skipped .github/workflows/diffci-verify.yml (pass --verification-workflow to add it)");
  console.log(`\nDefault agent command: ${agentCommand}`);
  console.log("\nDiffCI counts plan, check, observe and verify runs with the repository name (host/owner/repo), never its content. diffci telemetry --mode count-only drops the name; DO_NOT_TRACK=1 stops counting.");
  return 0;
}

function runMcp(): number {
  const result = spawnSync(process.execPath, [join(dirname(import.meta.filename), "mcp.js")], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (typeof result.status === "number") return result.status;
  if (result.error) throw result.error;
  return 0;
}

async function runAgentStopCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const agent = stringFlag(flags, "agent") as HookAgent | undefined;
  if (!agent || !HOOK_AGENTS.includes(agent)) {
    console.error(`diffci agent-stop needs --agent ${HOOK_AGENTS.join("|")}`);
    return 2;
  }
  // Every exit is 0 with JSON on stdout: a hook that fails would neither stop the agent nor tell it why.
  if (env.DIFFCI_AGENT_HOOK === "0") {
    console.log("{}");
    return 0;
  }
  const payload = parseStopPayload(await readStdin());
  const repoPath = resolve(stopRepoPath(payload, env as Record<string, string | undefined>, process.cwd()));
  const attempts = sessionAttempts(repoPath, payload);
  let report: VerificationReport | undefined;
  try {
    const identity = observerIdentity();
    report = await verifyChanged({
      repoPath,
      env: env as Record<string, string | undefined>,
      version: identity.version,
      engineSha: identity.sha,
      // Below the hook's own timeout (agent-setup.ts), so the hook always answers.
      timeoutMs: (AGENT_HOOK_TIMEOUT_SECONDS - 120) * 1000,
      tailBytes: 12_000,
      skipChecks: env.DIFFCI_CHECKS === "0",
    });
    appendOutcome(repoPath, report, env as Record<string, string | undefined>);
  } catch {
    report = undefined;
  }
  const decision = decideStop(agent, report, attempts.failures, maxAttempts(env as Record<string, string | undefined>));
  attempts.record(decision.failures);
  console.log(decision.stdout);
  return 0;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolveText) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolveText(text));
    process.stdin.on("error", () => resolveText(text));
  });
}

async function runWatchCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const repoPath = resolve(stringFlag(flags, "repo") ?? process.cwd());
  const identity = observerIdentity();
  const checks = flags.checks === true;
  console.log(`DiffCI watching ${repoPath}: verifies the uncommitted changes after each save${checks ? "" : " (tests only; --checks adds lint, typecheck and other checks)"}. Ctrl+C stops.`);
  const session = startWatch({
    repoPath,
    debounceMs: numberFlag(flags, "debounce-ms") ?? 300,
    currentTree: () => { try { return captureWorkingTreeSnapshot(repoPath).treeSha; } catch { return undefined; } },
    run: async () => {
      const started = Date.now();
      const report = await verifyChanged({
        repoPath,
        env: env as Record<string, string | undefined>,
        version: identity.version,
        engineSha: identity.sha,
        timeoutMs: numberFlag(flags, "timeout-ms") ?? 30 * 60 * 1000,
        tailBytes: 12_000,
        skipChecks: !checks,
      });
      if (flags["no-log"] !== true) appendOutcome(repoPath, report, env as Record<string, string | undefined>);
      console.log(formatWatchRun(report, Date.now() - started));
      return { treeSha: report.snapshot.after_tree_sha ?? report.snapshot.before_tree_sha };
    },
  });
  await new Promise<void>((resolveStop) => process.once("SIGINT", () => { session.stop(); resolveStop(); }));
  return 0;
}

/** One line for a pass, the full summary for anything else, so a failure shows what broke. */
function formatWatchRun(report: VerificationReport, wallMs: number): string {
  const time = new Date().toTimeString().slice(0, 8);
  if (report.selection === "none" && report.verification === "passed") return `${time}  no uncommitted changes`;
  if (report.verification === "passed") {
    const how = report.reused_from ? "reused an earlier pass of this tree" : `${report.selection} ${report.tests_selected} of ${report.tests_available} test files`;
    return `${time}  passed  ${how}  (${(wallMs / 1000).toFixed(1)}s)`;
  }
  return `${time}  ${report.verification.toUpperCase()}
${formatVerificationSummary(report)}`;
}

async function runVerifyCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const changed = flags.changed === true;
  if (changed && (flags.base !== undefined || flags.head !== undefined)) {
    console.error("diffci verify accepts either --changed or --base/--head, not both");
    return 2;
  }
  const policy = flags.policy === true ? "" : stringFlag(flags, "policy");
  if (policy !== undefined && policy !== "enforce") {
    console.error(`diffci verify --policy accepts only "enforce", got ${JSON.stringify(policy)}`);
    return 2;
  }
  if (policy !== undefined && changed) {
    console.error("diffci verify --policy enforce applies to a commit range, not --changed");
    return 2;
  }
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const out = stringFlag(flags, "out");
  const reportPath = out ? resolve(out) : undefined;
  if (reportPath && (reportPath === repoPath || isInsideRepository(repoPath, reportPath))) {
    console.error(`Refusing to write the verification receipt inside the repository: ${reportPath}. Use --out with a path outside the checkout.`);
    return 2;
  }
  const shardFlag = stringFlag(flags, "shard");
  const shard = shardFlag === undefined ? undefined : parseShard(shardFlag);
  if (shardFlag !== undefined && !shard) {
    console.error(`diffci verify --shard takes i/N with 1 <= i <= N, got ${JSON.stringify(shardFlag)}`);
    return 2;
  }
  const timingsFlag = stringFlag(flags, "timings");
  let timings: TimingsFile | undefined;
  if (timingsFlag !== undefined) {
    if (!shard) {
      console.error("diffci verify --timings balances --shard; pass both");
      return 2;
    }
    try { timings = readTimings(resolve(timingsFlag)); }
    catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  const identity = observerIdentity();
  const common = {
    repoPath,
    env: env as Record<string, string | undefined>,
    version: identity.version,
    engineSha: identity.sha,
    timeoutMs: numberFlag(flags, "timeout-ms") ?? 30 * 60 * 1000,
    tailBytes: numberFlag(flags, "tail-bytes") ?? 12_000,
    redactPaths: flags["redact-paths"] === true,
    baselineOnFailure: flags["baseline-on-failure"] === true || env.DIFFCI_BASELINE_ON_FAILURE === "1",
    // Gate checks are for before push; in CI the repository's own check jobs already run them.
    skipChecks: flags["no-checks"] === true || env.DIFFCI_CHECKS === "0" || (Boolean(env.CI) && env.CI !== "false" && flags.checks !== true),
    reuse: flags["no-reuse"] !== true && env.DIFFCI_REUSE !== "0",
    rank: flags["no-rank"] !== true && env.DIFFCI_RANK !== "0",
    failFast: flags["fail-fast"] === true,
    coverage: flags["no-coverage"] !== true && env.DIFFCI_COVERAGE !== "0",
    ...(shard ? { shard } : {}),
    ...(timings ? { timings } : {}),
  };
  const report = changed
    ? await verifyChanged(common)
    : await verifyRange({
        ...common,
        baseOverride: stringFlag(flags, "base"),
        headOverride: stringFlag(flags, "head"),
        policy,
      });
  await recordUsage("verify", report.verification, identity.version, flags, env, repoPath);
  if (flags["no-log"] !== true) appendOutcome(repoPath, report, env as Record<string, string | undefined>);
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (flags.json === true) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(formatVerificationSummary(report));
    if (reportPath) console.log(`  receipt: ${reportPath}`);
  }
  return verificationExitCode(report);
}

function runCoverageCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const command = stringFlag(flags, "command") ?? inferFullCommand(repoPath).command;
  if (!command) {
    console.error(`diffci coverage: no full test command could be inferred for ${repoPath}; pass --command`);
    return 2;
  }
  const run = buildCoverageMap(repoPath, command, { timeoutMs: numberFlag(flags, "timeout-ms") ?? 60 * 60 * 1000 });
  console.log(flags.json === true ? JSON.stringify({ ...(run.path ? { path: run.path } : {}), ...(run.error ? { error: run.error } : {}), exit_code: run.execution.exitCode, ...(run.map ? { tests: Object.keys(run.map.tests).length } : {}) }, null, 2) : formatCoverageRun(run));
  return run.map ? 0 : 1;
}

function runOutcomesCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const path = outcomeLogPath(repoPath);
  if (!path) {
    console.error(`Not a Git repository: ${repoPath}`);
    return 2;
  }
  const records = readOutcomes(path);
  if (flags.timings === true) {
    console.log(JSON.stringify(timingsFromOutcomes(records), null, 2));
    return 0;
  }
  if (flags.curve === true) {
    const curve = confidenceCurve(records);
    console.log(flags.json === true ? JSON.stringify({ log: path, ...curve }, null, 2) : formatConfidenceCurve(curve));
    return 0;
  }
  const summary = summarizeOutcomes(records);
  console.log(flags.json === true ? JSON.stringify({ log: path, ...summary }, null, 2) : formatOutcomeSummary(summary, path));
  return 0;
}

async function runGateCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const mode = stringFlag(flags, "mode") ?? "observe";
  if (mode !== "observe") {
    console.error(`diffci gate supports only --mode observe for now, got ${JSON.stringify(mode)}`);
    return 2;
  }
  const only = stringFlag(flags, "only");
  if (only !== undefined && only !== "checks" && only !== "tests") {
    console.error(`diffci gate --only accepts "checks" or "tests", got ${JSON.stringify(only)}`);
    return 2;
  }
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const out = stringFlag(flags, "out");
  const reportPath = out ? resolve(out) : undefined;
  if (reportPath && (reportPath === repoPath || isInsideRepository(repoPath, reportPath))) {
    console.error(`Refusing to write the gate report inside the repository: ${reportPath}. Use --out with a path outside the checkout.`);
    return 2;
  }
  const identity = observerIdentity();
  const scripts = stringFlag(flags, "script")?.split(",").map((name) => name.trim()).filter(Boolean);
  const common = {
    repoPath,
    env: env as Record<string, string | undefined>,
    version: identity.version,
    engineSha: identity.sha,
    baseOverride: stringFlag(flags, "base"),
    headOverride: stringFlag(flags, "head"),
    scripts,
  };

  // Plan only: where the checkout has history, for a gate that runs where it does not. Never fails, so a
  // build that plans first is not stopped by DiffCI; an unusable plan makes the gate run unplanned.
  const planOut = stringFlag(flags, "plan-out");
  if (planOut) {
    const planPath = resolve(planOut);
    if (planPath === repoPath || isInsideRepository(repoPath, planPath)) {
      console.error(`Refusing to write the gate plan inside the repository: ${planPath}. Use a path outside the checkout.`);
      return 2;
    }
    const plan = await planGate(common);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    console.log(`DiffCI gate plan: ${plan.analysis.status}${plan.range ? ` ${plan.range.base_sha.slice(0, 12)}..${plan.range.head_sha.slice(0, 12)}` : ""}${plan.analysis.reason ? ` - ${plan.analysis.reason}` : ""}`);
    console.log(`  ${plan.checks.filter((check) => check.decision === "SKIP").length} of ${plan.checks.length} checks would be skipped; tests: ${plan.tests.selection} (${plan.tests.tests_selected}/${plan.tests.tests_available})`);
    console.log(`  plan: ${planPath}`);
    return 0;
  }
  const planFile = stringFlag(flags, "plan");
  let plan: unknown;
  if (planFile) {
    try { plan = JSON.parse(readFileSync(resolve(planFile), "utf8")); } catch { plan = null; }
  }

  const report = await runGate({
    ...common,
    tests: stringFlag(flags, "tests"),
    measureSelected: flags["measure-selected"] === true,
    only: only as "checks" | "tests" | undefined,
    ...(planFile ? { plan, expectHead: stringFlag(flags, "expect-head") } : {}),
    timeoutMs: numberFlag(flags, "timeout-ms") ?? 60 * 60 * 1000,
    tailBytes: numberFlag(flags, "tail-bytes") ?? 12_000,
  });
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (flags.json === true) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(formatGateSummary(report));
    if (reportPath) console.log(`  report: ${reportPath}`);
  }
  return gateExitCode(report);
}

function formatFinding(finding: WorkflowFinding): string {
  const where = finding.job ? `${finding.workflow}#${finding.job}` : finding.workflow;
  return `  [${finding.severity}] ${finding.code} (${where})\n      ${finding.message}`;
}

function summarise(report: ObservationReport, executionFollows = false): string {
  const lines: string[] = [];
  lines.push(`DiffCI observation: ${report.status} (${report.stage})`);
  if (report.reason) lines.push(`  reason: ${report.reason}`);
  if (report.commitRange) {
    lines.push(
      `  range: ${report.commitRange.baseSha.slice(0, 12)}..${report.commitRange.headSha.slice(0, 12)} (${report.commitRange.source})`,
    );
  }
  const result = report.result;
  if (result) {
    lines.push(`  verdict: ${result.mode}`);
    if (result.goScope) lines.push("  Go scope: root module only; nested-module CI remains separate");
    if (result.vueScope) lines.push(`  Vue suite: ${result.vueScope.packageRoot} (${result.vueScope.testConfig})`);
    lines.push(
      `  selection: ${result.selectedTests.length}/${result.totalTestCount} test files, from ${result.changedFileCount} changed file(s)`,
    );
    lines.push(
      `  comparator: a simple path-rule CI would have run ${result.pathBaseline.mode === "FULL" ? "everything" : `${result.pathBaseline.selectedTestCount} test file(s)`}`,
    );
    if (result.mode === "FULL") {
      lines.push("  planned reduction: 0% test files (full validation required); runtime savings unmeasured");
    } else if (result.commandRefusalReason || result.proposedCommands.length === 0) {
      lines.push("  planned reduction: unavailable (no runnable selected command); runtime savings unmeasured");
    } else if (result.workspaceCommands) {
      lines.push("  workspace execution retains full auxiliary and non-isolated suites; affected-file counts do not measure execution reduction");
    } else if (result.totalTestCount > 0) {
      const avoided = Math.max(0, result.totalTestCount - result.selectedTests.length);
      const percent = (avoided / result.totalTestCount) * 100;
      lines.push(`  planned reduction: ${avoided}/${result.totalTestCount} test files (${percent.toFixed(1)}%) vs full; runtime savings unmeasured`);
    } else {
      lines.push("  planned reduction: unavailable (no discovered tests); runtime savings unmeasured");
    }
    const changeConfidence = result.graph.effectiveConfidence ?? result.graph.confidence;
    lines.push(`  graph: ${result.graph.nodes} nodes, confidence ${changeConfidence} for this change`);
    if (result.graph.confidence !== changeConfidence || (result.graph.confidenceReasons?.length && changeConfidence !== "COMPLETE")) {
      lines.push(`  repository graph: ${result.graph.confidence}${result.graph.confidenceReasons?.length ? ` (${result.graph.confidenceReasons.join("; ")})` : ""}`);
    }
    if (result.fallbackReasons.length > 0) {
      lines.push(`  fallback: ${result.fallbackReasons.join("; ")}`);
      for (const [path, blockers] of Object.entries(result.fallbackDetails ?? {})) {
        lines.push(`  why ${path} is unknown:`);
        for (const blocker of blockers) lines.push(`    - ${blocker}`);
      }
    }
    for (const command of result.proposedCommands) lines.push(`  would have run: ${command}`);
    if (result.commandRefusalReason) lines.push(`  no command: ${result.commandRefusalReason}`);
    if (result.blindSpot) {
      lines.push("  blind spot: this repository declares a test framework and DiffCI discovered none of its tests");
    }
  }
  lines.push(
    `  non-interference${executionFollows ? " (analysis phase)" : ""}: worktree ${report.nonInterference.worktreeUnchanged ? "unchanged" : "CHANGED - report this"}, report written ${report.nonInterference.reportWrittenOutsideRepository ? "outside" : "INSIDE"} the checkout`,
  );
  const blocking = report.nonInterference.workflowFindings.filter((f) => f.severity === "BLOCKING");
  // `check` is a local trial, not an installation, so it names the count and where to look; `observe`
  // runs inside the installation being judged and keeps every finding in its log.
  if (blocking.length > 0 && executionFollows) {
    const jobs = new Set(blocking.map((finding) => `${finding.workflow}#${finding.job ?? ""}`));
    lines.push(`  workflow: ${blocking.length} blocking finding(s) in ${jobs.size} DiffCI job(s) could let an observer affect CI; run \`diffci verify-workflow\` for details`);
  } else if (blocking.length > 0) {
    lines.push(`  workflow: ${blocking.length} blocking finding(s) - this installation CAN affect other jobs:`);
    for (const finding of blocking) lines.push(formatFinding(finding));
  }
  lines.push(executionFollows
    ? "  Analysis phase complete; check runs test commands only when a valid comparison is available."
    : "  DiffCI changed nothing: no test was run, skipped, cancelled or re-ordered by this step.");
  return lines.join("\n");
}

async function runCheck(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const reportPath = resolve(stringFlag(flags, "out") ?? defaultReportPath(env));
  const observationCode = await runObserve({ ...flags, out: reportPath, quiet: true, "no-send": true, "skip-usage": true }, env);
  if (observationCode !== 0) return observationCode;
  const observation = JSON.parse(readFileSync(reportPath, "utf8")) as ObservationReport;
  await recordUsage("check", observation.status === "OBSERVED" ? "observed" : observation.status === "REFUSED" ? "refused" : "error", observerIdentity().version, flags, env, repoPath);
  const print = (message: string): void => { if (flags.quiet !== true && flags.json !== true) console.log(message); };
  print(summarise(observation, true));
  print(`  observation report: ${reportPath}`);
  if (observation.status !== "OBSERVED" || !observation.result) {
    print("  timing: unavailable because analysis did not complete");
    if (flags.json === true) console.log(JSON.stringify({ observation, timing: null }, null, 2));
    return flags["fail-on-error"] === true ? 1 : 0;
  }
  const checkedOutHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (observation.commitRange?.headSha !== checkedOutHead) {
    const reason = "the analyzed head is not checked out; timing would execute a different revision";
    print(`  timing: unavailable (${reason})`);
    if (flags.json === true) console.log(JSON.stringify({ observation, timing: null, reason }, null, 2));
    return 1;
  }

  const commandPlanningStarted = performance.now();
  const workspace = observation.result.mode !== "FULL" && !observation.result.commandRefusalReason
    ? inferWorkspaceComparison(repoPath, observation.result.proposedCommands, observation.result.selectedTests) : undefined;
  const inferred = workspace?.full ? { command: workspace.full, reason: workspace.reason } : inferFullCommand(repoPath);
  if (!inferred.command) {
    print(`  timing: unavailable (${inferred.reason})`);
    if (flags.json === true) console.log(JSON.stringify({ observation, timing: null, reason: inferred.reason }, null, 2));
    return 0;
  }
  print(`  full command: ${inferred.command} (${inferred.reason})`);
  const timeoutMs = numberFlag(flags, "timeout-ms") ?? 30 * 60 * 1000;
  const tailBytes = numberFlag(flags, "tail-bytes") ?? 12_000;
  const savingsPath = reportPath.endsWith(".json") ? reportPath.slice(0, -5) + "-savings.json" : reportPath + ".savings.json";
  const markdownPath = savingsPath.replace(/\.json$/, ".md");

  if (observation.result.mode === "FULL") {
    print("  running full validation...");
    const full = measureCommand(inferred.command, { cwd: repoPath, timeoutMs, tailBytes });
    writeFileSync(savingsPath, `${JSON.stringify({ schema: "diffci.fullValidation.v1", observationReportPath: reportPath, full }, null, 2)}\n`, "utf8");
    print(full.exitCode === 0 && !full.timedOut
      ? `DiffCI check: full validation passed in ${(full.wallMs / 1000).toFixed(2)}s; 0% measured reduction for this commit`
      : `DiffCI check: full validation failed (exit ${String(full.exitCode)}); savings unavailable`);
    print(`  execution report: ${savingsPath}`);
    if (flags.json === true) console.log(JSON.stringify({ observation, full }, null, 2));
    return full.exitCode === 0 && !full.timedOut ? 0 : 1;
  }

  if (observation.result.commandRefusalReason || (!workspace?.selected && observation.result.proposedCommands.length !== 1)) {
    const reason = observation.result.commandRefusalReason ?? "the selection has no single runnable command";
    print(`  timing: unavailable (${reason})`);
    if (flags.json === true) console.log(JSON.stringify({ observation, timing: null, reason }, null, 2));
    return 0;
  }

  const selected = workspace?.selected ? { command: workspace.selected, reason: workspace.reason }
    : inferComparableSelectedCommand(repoPath, observation.result.proposedCommands[0], observation.result.selectedTests);
  if (!selected.command) {
    print(`  timing: unavailable (${selected.reason})`);
    if (flags.json === true) console.log(JSON.stringify({ observation, timing: null, reason: selected.reason }, null, 2));
    return 0;
  }
  if (selected.command !== observation.result.proposedCommands[0]) print(`  selected command: ${selected.command} (${selected.reason})`);

  print("  running full and selected validation...");
  const savings = runVerifySavings({
    full: inferred.command,
    selectedFromReport: reportPath,
    selectedCommandOverride: selected.command,
    analysisOverheadMs: observation.timings.totalMs + performance.now() - commandPlanningStarted,
    out: savingsPath,
    markdown: markdownPath,
    label: stringFlag(flags, "label") ?? basename(repoPath),
    cwd: repoPath,
    timeoutMs,
    tailBytes,
    repetitions: numberFlag(flags, "repetitions"),
    cacheState: parseCacheState(flags),
    cachePreparationCommand: stringFlag(flags, "cache-prepare"),
    alternateOrder: flags["fixed-order"] === true ? false : undefined,
  });
  writeVerifySavingsReport(savings, { out: savingsPath, markdown: markdownPath });
  print(formatVerifySavingsSummary(savings));
  if (formatGrowthPrompt(savings)) print(formatGrowthPrompt(savings));
  print(`  savings report: ${savingsPath}`);
  print(`  markdown: ${markdownPath}`);
  if (flags.json === true) console.log(JSON.stringify({ observation, savings }, null, 2));
  return savings.comparison.evidenceValid ? 0 : 1;
}

async function runObserve(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const repoPath = resolve(typeof flags.repo === "string" ? flags.repo : env.GITHUB_WORKSPACE ?? process.cwd());
  const reportPath = resolve(typeof flags.out === "string" ? flags.out : defaultReportPath(env));

  if (isInsideRepository(repoPath, reportPath) && flags["allow-in-tree-report"] !== true) {
    // Refused rather than relocated: a caller who asked for a path inside the checkout may have a
    // reason, and silently writing somewhere else would make the artifact they collect disappear.
    console.error(
      `Refusing to write the report to ${reportPath}: it is inside the repository being observed, where an untracked file changes \`git status\` and can fail a clean-tree check. Pass --out with a path outside the checkout (RUNNER_TEMP is the default), or --allow-in-tree-report to accept that risk.`,
    );
    return 2;
  }

  const identity = observerIdentity();
  let economicsHistory: unknown;
  if (typeof flags["economics-history"] === "string") {
    try { economicsHistory = JSON.parse(readFileSync(resolve(flags["economics-history"]), "utf8")); }
    catch { console.warn("DiffCI timing history is unreadable; performing normal analysis."); }
  }
  // Opt-in graph cache: local with --graph-cache-dir, plus DiffCI Cloud with --shared-graph-cache.
  const graphCacheConfig = configureGraphCache({
    repoPath,
    version: identity.version,
    localDir: typeof flags["graph-cache-dir"] === "string" ? resolve(flags["graph-cache-dir"]) : env.DIFFCI_GRAPH_CACHE_DIR ? resolve(env.DIFFCI_GRAPH_CACHE_DIR) : undefined,
    shared: flags["shared-graph-cache"] === true || env.DIFFCI_SHARED_GRAPH_CACHE === "1",
    cacheUrl: typeof flags["graph-cache-url"] === "string" ? flags["graph-cache-url"] : env.DIFFCI_GRAPH_CACHE_URL,
    apiUrl: typeof flags["api-url"] === "string" ? flags["api-url"] : env.DIFFCI_API_URL,
    token: typeof flags["api-token"] === "string" ? flags["api-token"] : env.DIFFCI_TOKEN,
    secret: env.DIFFCI_GRAPH_CACHE_SECRET,
    noSend: flags["no-send"] === true || env.DIFFCI_NO_SEND === "1",
    redactPaths: flags["redact-paths"] === true,
    defaultLocalRoot: env.RUNNER_TEMP ?? tmpdir(),
    local: (dir) => new GraphCache({ cacheDir: dir }),
    isInsideRepository,
  });
  const report = await observe({
    graphCache: graphCacheConfig.cache,
    repoPath,
    env: env as Record<string, string | undefined>,
    version: identity.version,
    engineSha: identity.sha,
    baseOverride: typeof flags.base === "string" ? flags.base : undefined,
    headOverride: typeof flags.head === "string" ? flags.head : undefined,
    redactPaths: flags["redact-paths"] === true,
    reportPath,
    economicsHistory,
    economicsJobKey: typeof flags["economics-job"] === "string" ? flags["economics-job"] : undefined,
    forceAnalysis: flags["force-analysis"] === true,
    vueAnalysisCacheDir: typeof flags["vue-analysis-cache"] === "string" ? flags["vue-analysis-cache"] : undefined,
    agent: resolveObservationAgent(flags.agent, env as Record<string, string | undefined>),
  });

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // check counts itself; its inner observation is not a second run.
  if (flags["skip-usage"] !== true) await recordUsage("observe", report.status === "OBSERVED" ? "observed" : report.status === "REFUSED" ? "refused" : "error", identity.version, flags, env, repoPath);

  const summary = summarise(report);
  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.quiet !== true) {
    console.log(summary);
    console.log(`  report: ${reportPath}`);
  }
  if (graphCacheConfig.cache || graphCacheConfig.notes.length) {
    await graphCacheConfig.cache?.flush();
    if (flags.quiet !== true && flags.json !== true) {
      for (const note of graphCacheConfig.notes) console.log(`  graph cache: ${note}`);
      if (graphCacheConfig.cache?.lastOutcome) console.log(`  graph cache: ${graphCacheConfig.cache.lastOutcome}`);
    }
  }

  // Sending happens before the job summary is written, so the summary can say whether it worked.
  // It is allowed to fail: by this point the report is on disk and (in the action) about to become an
  // artifact, so a delivery problem costs the observation nothing - it is DiffCI's problem to fix, not
  // the host repository's build to fail.
  const apiUrl = typeof flags["api-url"] === "string" ? flags["api-url"] : env.DIFFCI_API_URL;
  const apiToken = typeof flags["api-token"] === "string" ? flags["api-token"] : env.DIFFCI_TOKEN;
  let delivery: string | undefined;
  if (apiUrl && apiToken && flags["no-send"] !== true) {
    const outcome = await submitObservation({ apiUrl, token: apiToken, report });
    delivery = outcome.ok
      ? `sent${outcome.duplicate ? " (already recorded - a re-run or retry of the same observation)" : ""}`
      : `not sent (${outcome.kind}): ${outcome.message}`;
    if (flags.quiet !== true) console.log(`  delivery: ${delivery}`);
  } else if (apiUrl && !apiToken && flags["no-send"] !== true) {
    delivery = "not sent: an api-url was given with no api-token";
    if (flags.quiet !== true) console.log(`  delivery: ${delivery}`);
  }

  if (delivery) {
    const warning = githubDeliveryWarning(delivery, env);
    if (warning) console.log(warning);
  }

  // GitHub renders this under the job. It is the only place most people will ever read a report, so it
  // says the same thing the report says, including when the answer is "refused" or "not sent".
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(env.GITHUB_STEP_SUMMARY, formatJobSummary(report, summary, delivery), { flag: "a" });
    } catch {
      // Losing the summary is cosmetic; the report on disk is the record.
    }
  }
  // The same Markdown for CI systems without a step summary (the GitLab component exposes it as an artifact).
  const summaryOut = stringFlag(flags, "summary-out");
  if (summaryOut) {
    try {
      mkdirSync(dirname(resolve(summaryOut)), { recursive: true });
      writeFileSync(resolve(summaryOut), formatJobSummary(report, summary, delivery), "utf8");
    } catch {
      // Cosmetic, as above.
    }
  }

  if (env.GITHUB_OUTPUT) {
    try {
      writeFileSync(env.GITHUB_OUTPUT, `report-path=${reportPath}\nstatus=${report.status}\n`, { flag: "a" });
    } catch {
      // Same: the outputs are a convenience for the workflow, not the record.
    }
  }

  if (flags["fail-on-error"] === true && report.status !== "OBSERVED") return 1;
  return 0;
}

function runVerifyWorkflow(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const repoPath = resolve(typeof flags.repo === "string" ? flags.repo : env.GITHUB_WORKSPACE ?? process.cwd());
  const result = auditWorkflows(repoPath);

  if (result.workflowsScanned.length === 0) {
    console.log(`No workflow files found under ${join(repoPath, ".github", "workflows")}. Nothing was checked.`);
    return 1;
  }
  console.log(`Scanned ${result.workflowsScanned.length} workflow file(s).`);
  if (result.observerJobs.length === 0) {
    // Jobs that run DiffCI as a gate (verify, check-run, fail-on-error) are allowed to fail and are not
    // observers, but their warnings still belong in front of the user rather than behind this return.
    for (const finding of result.findings) console.log(formatFinding(finding));
    console.log("No job runs DiffCI as an observer (jobs that run it as a gate, with verify, check-run or fail-on-error, are allowed to fail and are not checked here). Add an observer job before starting the observation window.");
    return 1;
  }
  console.log(`DiffCI runs in: ${result.observerJobs.join(", ")}`);

  if (result.findings.length === 0) {
    console.log("No findings: nothing in these workflows lets the observation change what the rest of CI does.");
    return 0;
  }
  for (const finding of result.findings) console.log(formatFinding(finding));
  if (isNonInterfering(result)) {
    console.log("\nNo blocking findings. The observation cannot change what the rest of CI does.");
    return 0;
  }
  console.log("\nBlocking findings above: as written, this installation CAN change what the rest of CI does.");
  return 1;
}

/**
 * `verify-workflow --enforce` (docs/enforce-mode-01-plan.md, step 4). The observer audit cannot apply:
 * an enforcing job is meant to change CI. This checks the opposite - that the gate is real, that its
 * kill switch is the repository variable, and that the full suite still runs on every push to main.
 */
function runVerifyEnforceWorkflow(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const result = auditEnforceWorkflows(repoPath, {
    defaultBranch: stringFlag(flags, "default-branch"),
    fullCommand: stringFlag(flags, "full-command"),
  });

  if (result.workflowsScanned.length === 0) {
    console.log(`No workflow files found under ${join(repoPath, ".github", "workflows")}. Nothing was checked.`);
    return 1;
  }
  console.log(`Scanned ${result.workflowsScanned.length} workflow file(s).`);
  console.log(`Enforcing job(s): ${result.enforceJobs.length ? result.enforceJobs.join(", ") : "none"}`);
  console.log(`Full suite (${result.fullCommand ?? "unknown"}) on every push: ${result.fullSuiteJobs.length ? result.fullSuiteJobs.join(", ") : "none"}`);
  for (const finding of result.findings) console.log(formatFinding(finding));
  if (isNonInterfering(result)) {
    console.log("\nNo blocking findings. Enforcement is gated by DIFFCI_ENFORCE and the full suite still runs on push.");
    return 0;
  }
  console.log("\nBlocking findings above: as written, enforce mode could skip tests with nothing checking the skips.");
  return 1;
}

/**
 * Miss detection (docs/enforce-mode-01-plan.md, step 5). Exit 0: no miss. Exit 1: at least one miss.
 * Exit 2: the full run left no results to classify, or the invocation is wrong. It never edits
 * diffci.config.json or repository variables; it prints the entries for a human to add.
 */
function runEnforceMisses(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const junitPath = stringFlag(flags, "junit");
  const outFlag = stringFlag(flags, "out-dir");
  const repository = stringFlag(flags, "repository") ?? env.GITHUB_REPOSITORY;
  if (!junitPath || !outFlag || !repository) {
    console.error("diffci enforce-misses needs --junit <file>, --out-dir <dir> and --repository <owner/name> (or GITHUB_REPOSITORY)");
    return 2;
  }
  const outDir = resolve(outFlag);
  if (outDir === repoPath || isInsideRepository(repoPath, outDir)) {
    console.error(`Refusing to write the miss report inside the repository: ${outDir}. Use --out-dir outside the checkout.`);
    return 2;
  }
  if (!existsSync(junitPath)) {
    console.error(`No full-suite results at ${junitPath}: nothing can be classified, so no miss can be ruled out.`);
    return 2;
  }
  let fullRun: ReturnType<typeof parseJunit>;
  try { fullRun = parseJunit(readCheckPlanInput(junitPath), repoPath); }
  catch (error) {
    console.error(`Cannot read full-suite JUnit: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const headSha = stringFlag(flags, "head") ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
  const failing = fullRun.filter((outcome) => outcome.failed);
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const notes: string[] = [];

  let report: MissReport;
  if (failing.length === 0) {
    // A green run is the cheapest case and the most common one: no GitHub calls, and its record
    // (no failures) becomes the next run's window start.
    report = buildMissReport({ fullRun, rerun: undefined, baseline: [], pullRequests: [], headSha, producedAt: new Date().toISOString(), runUrl, window: { from_sha: null, source: "none" } });
  } else {
    const rerunJunit = stringFlag(flags, "rerun-junit");
    const rerunArgs = inferRerunArgs(repoPath);
    const files = [...new Set(failing.map((outcome) => outcome.file).filter(Boolean))];
    let rerun: ReturnType<typeof parseJunit> | undefined;
    try {
      rerun = rerunJunit ? parseJunit(readCheckPlanInput(rerunJunit), repoPath)
        : rerunArgs && files.length > 0 ? rerunFailingFiles(repoPath, rerunArgs, files) : undefined;
    } catch (error) {
      notes.push(`rerun results unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!rerun) notes.push("failures were not re-run, so none could be ruled flaky; every failure was treated as deterministic");

    const collect: CollectOptions = {
      repoPath,
      repository,
      headSha,
      runId: env.GITHUB_RUN_ID,
      workDir: join(outDir, "downloads"),
      run: spawnRunner,
    };
    const window = findWindowStart(collect);
    if (!window.fromSha) notes.push("no earlier detector record or green full run was found, so no pull request could be held against these failures");
    const pullRequests = mergedPullRequests(collect, window.fromSha).map((pr) => ({ ...pr, receipt: findReceipt(collect, pr) }));
    report = buildMissReport({
      fullRun,
      rerun,
      baseline: window.baseline,
      pullRequests,
      headSha,
      producedAt: new Date().toISOString(),
      runUrl,
      window: { from_sha: window.fromSha, source: window.source },
      notes,
    });
  }

  mkdirSync(outDir, { recursive: true });
  const markdown = formatMissReportMarkdown(report);
  writeFileSync(join(outDir, MISS_REPORT_FILE), `${JSON.stringify(report, null, 2)}
`, "utf8");
  writeFileSync(join(outDir, "enforce-misses.md"), markdown, "utf8");
  console.log(markdown);
  if (report.misses === 0) return 0;

  console.log("Add to enforce.openUnsafeMisses in diffci.config.json (not done automatically):");
  console.log(JSON.stringify(report.open_unsafe_misses, null, 2));
  if (flags["open-issue"] === true) {
    const title = `DiffCI enforce: unsafe miss on main at ${headSha.slice(0, 12)}`;
    const created = spawnRunner("gh", ["issue", "create", "--repo", repository, "--title", title, "--body-file", join(outDir, "enforce-misses.md")]);
    if (created.ok) console.log(`Opened ${created.stdout.trim()}`);
    else console.error(`Could not open an issue (${created.stderr.trim()}); the report is in ${outDir}.`);
  }
  return 1;
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative number`);
  return parsed;
}

function parseCacheState(flags: Record<string, string | boolean>): "cold" | "warm" | "unknown" | undefined {
  const value = stringFlag(flags, "cache-state");
  if (value === undefined) return undefined;
  if (value !== "cold" && value !== "warm" && value !== "unknown") throw new Error("--cache-state must be cold, warm, or unknown");
  return value;
}

function parseVerifySavingsOptions(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): VerifySavingsOptions {
  const full = stringFlag(flags, "full");
  const selected = stringFlag(flags, "selected");
  const selectedFromReport = stringFlag(flags, "selected-from-report");
  const out = stringFlag(flags, "out");
  if (!full) throw new Error("--full <command> is required");
  if (!selected && !selectedFromReport) throw new Error("--selected <command> or --selected-from-report <path> is required");
  if (selected && selectedFromReport) throw new Error("pass only one of --selected or --selected-from-report");
  if (!out) throw new Error("--out <path> is required");
  const markdown = stringFlag(flags, "markdown");
  return {
    full,
    selected,
    selectedFromReport: selectedFromReport ? resolve(selectedFromReport) : undefined,
    out: resolve(out),
    markdown: markdown ? resolve(markdown) : undefined,
    label: stringFlag(flags, "label"),
    cwd: resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd()),
    timeoutMs: numberFlag(flags, "timeout-ms") ?? 30 * 60 * 1000,
    analysisOverheadMs: numberFlag(flags, "analysis-overhead-ms"),
    tailBytes: numberFlag(flags, "tail-bytes") ?? 12_000,
    repetitions: numberFlag(flags, "repetitions"),
    cacheState: parseCacheState(flags),
    cachePreparationCommand: stringFlag(flags, "cache-prepare"),
    alternateOrder: flags["fixed-order"] === true ? false : undefined,
  };
}

function runVerifySavingsCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): number {
  const options = parseVerifySavingsOptions(flags, env);
  const report = runVerifySavings(options);
  writeVerifySavingsReport(report, { out: options.out, markdown: options.markdown });
  console.log(formatVerifySavingsSummary(report));
  if (formatGrowthPrompt(report)) console.log(formatGrowthPrompt(report));
  console.log(`  report: ${options.out}`);
  if (options.markdown) console.log(`  markdown: ${options.markdown}`);
  return report.comparison.evidenceValid ? 0 : 1;
}

function defaultPilotOutputDir(repoPath: string): string {
  return join(dirname(repoPath), "diffci-output");
}

async function runPilotPacket(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const outDir = resolve(stringFlag(flags, "out-dir") ?? defaultPilotOutputDir(repoPath));
  if (isInsideRepository(repoPath, outDir) || outDir === repoPath) {
    console.error(`Refusing to write pilot packet inside the repository: ${outDir}. Pass --out-dir with a path outside the checkout.`);
    return 2;
  }

  const label = stringFlag(flags, "label") ?? basename(repoPath);
  const repositoryUrl = stringFlag(flags, "repository-url");
  if (repositoryUrl && !/^https:\/\//i.test(repositoryUrl)) {
    console.error("--repository-url must be an https URL");
    return 2;
  }
  const observationPath = join(outDir, "diffci-observe.json");
  const packetPath = join(outDir, "pilot-packet.md");
  const workflowPath = join(outDir, "diffci-observe.yml");
  const identity = observerIdentity();
  const observation = await observe({
    repoPath,
    env: env as Record<string, string | undefined>,
    version: identity.version,
    engineSha: identity.sha,
    baseOverride: stringFlag(flags, "base"),
    headOverride: stringFlag(flags, "head"),
    redactPaths: flags["redact-paths"] === true,
    reportPath: observationPath,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(observationPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  writeFileSync(packetPath, renderPilotPacket(observation, { label, repositoryUrl }), "utf8");
  writeFileSync(workflowPath, buildPilotWorkflow(identity.version), "utf8");

  console.log(summarise(observation));
  console.log(`  packet: ${packetPath}`);
  console.log(`  observation report: ${observationPath}`);
  console.log(`  reviewable workflow: ${workflowPath}`);
  return observation.status === "OBSERVED" ? 0 : 1;
}

async function runPilot(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const full = stringFlag(flags, "full");
  const selectedOverride = stringFlag(flags, "selected");
  if (!full) {
    console.error('--full <command> is required, for example: diffci pilot --full "npm test"');
    return 1;
  }

  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const outDir = resolve(stringFlag(flags, "out-dir") ?? defaultPilotOutputDir(repoPath));
  if (isInsideRepository(repoPath, outDir) || outDir === repoPath) {
    console.error(`Refusing to write pilot reports inside the repository: ${outDir}. Pass --out-dir with a path outside the checkout.`);
    return 2;
  }

  const label = stringFlag(flags, "label") ?? basename(repoPath);
  const observationPath = join(outDir, "diffci-observe.json");
  const savingsPath = join(outDir, "diffci-savings.json");
  const markdownPath = join(outDir, "diffci-savings.md");

  const identity = observerIdentity();
  const observation = await observe({
    repoPath,
    env: env as Record<string, string | undefined>,
    version: identity.version,
    engineSha: identity.sha,
    baseOverride: stringFlag(flags, "base"),
    headOverride: stringFlag(flags, "head"),
    redactPaths: flags["redact-paths"] === true,
    reportPath: observationPath,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(observationPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");

  console.log(summarise(observation));
  console.log(`  observation report: ${observationPath}`);
  if (observation.status !== "OBSERVED") {
    console.log("DiffCI pilot stopped before timing because observation did not produce a selectable report.");
    return 1;
  }
  if (observation.result?.mode === "FULL") {
    console.log("DiffCI pilot: 0% planned test-file reduction on this commit (full validation required). No paired timing was run.");
    return 0;
  }
  if ((!observation.result?.proposedCommands.length || observation.result.commandRefusalReason) && !selectedOverride) {
    console.log("DiffCI pilot: no runnable selected command. No paired timing was run.");
    return 1;
  }

  const savings = runVerifySavings({
    full,
    selectedFromReport: observationPath,
    selectedCommandOverride: selectedOverride,
    out: savingsPath,
    markdown: markdownPath,
    label,
    cwd: repoPath,
    timeoutMs: numberFlag(flags, "timeout-ms") ?? 30 * 60 * 1000,
    analysisOverheadMs: numberFlag(flags, "analysis-overhead-ms"),
    tailBytes: numberFlag(flags, "tail-bytes") ?? 12_000,
    repetitions: numberFlag(flags, "repetitions"),
    cacheState: parseCacheState(flags),
    cachePreparationCommand: stringFlag(flags, "cache-prepare"),
    alternateOrder: flags["fixed-order"] === true ? false : undefined,
  });
  writeVerifySavingsReport(savings, { out: savingsPath, markdown: markdownPath });

  console.log(formatVerifySavingsSummary(savings));
  if (formatGrowthPrompt(savings)) console.log(formatGrowthPrompt(savings));
  console.log(`  savings report: ${savingsPath}`);
  console.log(`  markdown: ${markdownPath}`);
  return savings.comparison.evidenceValid ? 0 : 1;
}

function runValidateSpecs(flags: Record<string, string | boolean>): number {
  const file = stringFlag(flags, "file");
  if (!file) throw new Error("validate-specs requires --file <json>");
  const report = detectSpecificationConflicts(readSpecificationFile(file));
  if (flags.json === true) console.log(JSON.stringify(report, null, 2));
  else if (report.valid) console.log(`DiffCI specification validation: no conflicts across ${report.specificationsChecked} specification(s) and ${report.logicalTargetsChecked} logical target(s).`);
  else {
    console.log(`DiffCI specification validation: BLOCKED (${report.conflicts.length} logical-target conflict${report.conflicts.length === 1 ? "" : "s"})`);
    for (const blocker of report.blockers) console.log(`  ${blocker}`);
  }
  return report.valid ? 0 : 1;
}

const USAGE = `diffci - change-aware CI analysis and paired timing

Open-source engine: https://github.com/DiffCI/core
Pilot a repository: https://diffci.com/#pilot

Usage:
  diffci init [--repo <path>] [--workflow] [--verification-workflow] [--install] [--no-hook] [--no-mcp] [--no-skill]
              [--no-agent-hooks] [--force]
  diffci watch [--repo <path>] [--checks] [--debounce-ms <ms>] [--no-log]
  diffci agent-stop --agent claude|codex|cursor|copilot   (run by the agent stop hooks init installs; reads the hook JSON on stdin)
  diffci mcp
  diffci verify [--changed | --base <sha> --head <sha>] [--policy enforce] [--repo <path>] [--out <file>] [--json]
                [--redact-paths] [--timeout-ms <ms>] [--baseline-on-failure] [--no-checks | --checks]
                [--share-usage] [--no-send] [--no-log] [--no-reuse] [--no-rank] [--fail-fast]
                [--shard <i/N> [--timings <file>]] [--no-coverage]
  diffci telemetry [--mode repo|count-only] [--internal-usage]
  diffci check [--repo <path>] [--out <file>] [--base <sha> --head <sha>]
               [--redact-paths] [--json] [--quiet] [--fail-on-error] [--timeout-ms <ms>] [--share-usage]
  diffci plan --base <sha> [--head <sha>] [--repo <path>]
  diffci check-plan --plan <plan.json> --results <junit.xml>
  diffci red-builds <owner/repo> [--runs <n>] [--workflow <id|file>] [--json <file>] [--check-jobs <regex>] [--ci-only-jobs <regex>]
  diffci pilot --full <command> [--selected <command>] [--repo <path>] [--out-dir <dir>] [--label <name>]
  diffci pilot-packet [--repo <path>] [--out-dir <dir>] [--base <sha> --head <sha>]
                      [--label <name>] [--repository-url <https-url>] [--redact-paths]
  diffci observe [--repo <path>] [--out <file>] [--base <sha> --head <sha>]
                 [--redact-paths] [--json] [--quiet] [--fail-on-error] [--summary-out <file.md>]
                 [--api-url <url> --api-token <token>] [--no-send] [--share-usage] [--agent <name|auto>]
                 [--graph-cache-dir <dir>] [--shared-graph-cache [--graph-cache-url <url>]]
  diffci verify-savings --repo <path> --full <command>
                         (--selected <command> | --selected-from-report <file>)
                         --out <file> [--markdown <file>] [--label <name>]
                         [--repetitions <1-20>] [--cache-state cold|warm|unknown]
                         [--cache-prepare <command>] [--fixed-order]
  diffci validate-specs --file <json> [--json]
  diffci verify-workflow [--repo <path>]
  diffci verify-workflow --enforce [--repo <path>] [--default-branch main] [--full-command "<cmd>"]
  diffci gate [--base <sha> --head <sha>] [--tests <command>] [--script <name,...>] [--measure-selected]
              [--only checks|tests] [--plan <file> [--expect-head <sha>]] [--repo <path>] [--out <file>]
              [--json] [--timeout-ms <ms>]
  diffci gate --plan-out <file> [--base <sha> --head <sha>] [--script <name,...>] [--repo <path>]
  diffci enforce-misses --junit <file> --out-dir <dir> [--repository <owner/name>] [--repo <path>]
                        [--head <sha>] [--rerun-junit <file>] [--open-issue]
  diffci outcomes [--repo <path>] [--curve | --timings] [--json]
  diffci coverage [--repo <path>] [--command <cmd>] [--timeout-ms <ms>] [--json]
  diffci version

init writes AGENTS.md, CLAUDE.md, Cursor rules, Copilot instructions, and diffci.config.json. It also
registers the DiffCI MCP server in .mcp.json (Claude Code, VS Code), .cursor/mcp.json (Cursor),
.kiro/settings/mcp.json (Kiro) and .agents/mcp_config.json (Antigravity CLI), keeping other servers, adds the
diffci-verify skill to .claude/skills, .agents/skills and .kiro/skills, installs the pre-push hook, and adds stop
hooks (.claude/settings.json, .codex/hooks.json, .cursor/hooks.json, .github/hooks/diffci.json for GitHub
Copilot) that run diffci agent-stop when an agent ends a
turn: it verifies the uncommitted changes and, when tests or checks fail, asks the agent to fix them before
finishing, at most DIFFCI_AGENT_HOOK_MAX times a session (default 3; DIFFCI_AGENT_HOOK=0 turns it off).
--no-mcp, --no-skill, --no-hook and --no-agent-hooks leave each out. --workflow adds a separate non-blocking observation workflow. --install detects npm, pnpm, Yarn,
or Bun, installs this DiffCI version as an exact dev dependency, updates the manager's lockfile,
and adds diffci:verify, diffci:check, and diffci:observe package scripts without replacing existing scripts.
--verification-workflow adds a blocking GitHub check that uploads a commit-bound verification receipt.
The pre-push hook runs diffci verify on the commits being pushed and blocks the push
when verification fails (git push --no-verify skips it; DIFFCI_HOOK_STRICT=1 also blocks when it cannot verify).
mcp runs the stdio MCP server for native agent integrations.
verify --changed snapshots staged, unstaged, and non-ignored untracked changes, runs the minimum
executable verification (or full fallback), and exits zero only when that exact snapshot passes.
verify first runs the rest of the repository's gate (the check script's lint, typecheck and check-script
leaves) and stops at the first failure; --no-checks skips them, and they are skipped in CI unless --checks.
verify without --changed resolves the CI event range (or HEAD^..HEAD locally), requires a clean checkout,
and exits zero only when the analyzed head is the commit that actually passed verification.
check analyzes the change, runs inferred full and selected commands, and shows measured savings.
plan prints Core's advisory JSON plan for a clean checkout at --head; save it before the full suite runs.
It exits 1 with a RUN_FULL_CI error when it cannot plan. It runs no tests and sends nothing.
check-plan reads one saved plan and one full-suite JUnit result, and prints a JSON failure comparison.
It exits 1 for missed, possible-miss or unattributed failures, 2 for invalid inputs, and 0 otherwise. It runs no tests,
reads no Git state, writes no reports, and sends nothing. Each UTF-8 input must be at most 16 MiB.
pilot runs observe and verify-savings together, writing reports to ../diffci-output by default.
pilot-packet writes a shareable compatibility summary, raw observation, and non-blocking workflow
outside the checkout. It runs no tests, modifies no target-repository files, and sends nothing.
observe analyses the checkout and writes one JSON report. It runs nothing and changes nothing.
verify-savings runs both commands and reports measured paired runtime; it is an opt-in pilot command.
validate-specs checks an explicit list of specification IDs and logical targets and blocks duplicates.
verify-workflow checks that the job running DiffCI cannot affect any other job, and exits 1 if it can.
With --enforce it instead checks that an enforcing job exists, is gated by vars.DIFFCI_ENFORCE, and
that the full suite still runs on every push to the default branch; it exits 1 if any of that fails.
gate replaces a build's gate script (for example "npm run check && npm test"). In observe mode, the only
mode so far, it runs every gate check and the full test command (--tests, default the repository's test
script) exactly as the build would and exits with their result. It records what DiffCI would have run,
narrowed or skipped for the range, the time that would have saved, and any miss: a failing step DiffCI
would have skipped. Narrowed checks and selected tests run again only when their full step failed, unless
--measure-selected. --script adds gate scripts beyond check (comma-separated). --only checks or --only tests
runs one half, for builds that run checks and tests as separate stages. --plan-out only analyses the range
and writes DiffCI's decisions, for a gate that runs without git history; --plan uses that file instead of
analysing, and --expect-head ignores a plan made for another commit. It sends nothing.
enforce-misses classifies a full run's failures on main against the enforce dry-run receipts of the pull
requests merged since the last recorded run, and exits 1 on a miss. It never edits configuration.
verify appends each run (plan, selection reasons, checks, results, per-file durations, failing tests) to
.git/diffci/outcomes.jsonl, which is never committed and never sent; --no-log or DIFFCI_OUTCOME_LOG=0 skips it.
When an earlier run in that log passed on the exact same tree and covered the same tests and checks, verify
reuses it and runs nothing; --no-reuse or DIFFCI_REUSE=0 runs everything again. Selected tests that have
failed before in that log, or that the change edited, run first (--no-rank keeps the selection's order);
--fail-fast runs them as a first batch and stops there if one fails. --shard i/N runs job i's share of the
selection in an N-job CI matrix; every job splits it the same way, balanced by --timings (a file from
diffci outcomes --timings that every job reads) or else by file count. The full suite, test-script phases
and a selection that cannot be split run in shard 1.
coverage runs the full node:test suite once under a probe and V8 coverage and keeps, per test file, the files
it loaded, read or listed in .git/diffci/coverage-map.json. verify then also runs tests that map connects to a
changed file when the dependency graph did not select them; it only ever adds tests (--no-coverage ignores it).
watch verifies the uncommitted changes after each save, as verify --changed would, and prints one line per
pass and the full summary on a failure; tests only unless --checks.
outcomes summarises that log: results, selected and full runs, top full-run reasons, agents, and possible
misses (a selected run that passed and a later full run of the same tree that failed). --curve replays the
failing runs to show how soon the first failure is seen, ranked by history against path order. --timings
prints each test file's typical duration as JSON, for verify --shard --timings.
Failures are re-run with the package.json tsx --test runner, or read from --rerun-junit for other runners.

The report is sent only when both --api-url and --api-token are given (or DIFFCI_API_URL and
DIFFCI_TOKEN are set). A failed send is reported and never fails the step - the report is on disk
either way. Plain http is refused; the token is never printed.
--graph-cache-dir (or DIFFCI_GRAPH_CACHE_DIR) reuses dependency graphs for clean checkouts from a local
directory outside the checkout. --shared-graph-cache (or DIFFCI_SHARED_GRAPH_CACHE=1) also shares them via
DiffCI Cloud (Team/Business) using the api-url and api-token; DIFFCI_GRAPH_CACHE_SECRET encrypts them
client-side. Graphs hold paths and import edges, never file contents; a cache failure only means a local build.
Usage counting is on: plan, check, observe and verify send command, outcome, version, surface, CI or local,
activity, a random local installation ID and the repository name (host/owner/repo from GITHUB_REPOSITORY,
GitLab CI or the origin remote). diffci telemetry --mode count-only drops the name and the ID; --mode repo
restores them. --internal-usage labels tests/internal activity. No commit, path, test, report, content or
machine details are sent. Only DO_NOT_TRACK=1, DIFFCI_NO_SEND=1 or DIFFCI_SHARE_USAGE=0 stop counting;
--no-send stops report uploads only.
Interactive check and observe runs print feedback links to stderr at most weekly; they send nothing.
CI, MCP, --json and --quiet never show them; DIFFCI_NO_FEEDBACK_PROMPT=1 hides them.
`;

function maybeShowFeedbackPrompt(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): void {
  if (!shouldShowFeedbackPrompt(flags, env, process.stderr.isTTY === true)) return;
  // stderr keeps piped stdout unchanged.
  console.error(formatFeedbackPrompt(readTelemetryPreference(env).mode));
  markFeedbackPromptShown(env);
}

async function main(): Promise<void> {
  // This stateless command deliberately bypasses shared flag handling, telemetry and feedback.
  if (process.argv[2] === "check-plan") {
    process.exitCode = runCheckPlanCommand(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "plan") {
    process.exitCode = await runPlanCommand(process.argv.slice(3));
    return;
  }
  // Stateless and read-only like check-plan: no shared flags, telemetry or feedback prompt.
  if (process.argv[2] === "red-builds") {
    process.exitCode = await runRedBuildsCommand(process.argv.slice(3));
    return;
  }
  const { command, flags } = parseArgs(process.argv);
  const env = process.env;

  if (flags.help === true || command === "help" || command === undefined) {
    console.log(USAGE);
    process.exitCode = command === undefined ? 1 : 0;
    return;
  }

  switch (command) {
    case "telemetry": {
      const mode = stringFlag(flags, "mode");
      const preference = mode ? configureTelemetry(mode, flags["internal-usage"] === true, env) : readTelemetryPreference(env);
      console.log(`DiffCI telemetry: ${preference.mode}; activity: ${preference.internal ? "internal" : "external"}.`);
      console.log(telemetryNotice(preference.mode));
      process.exitCode = 0;
      return;
    }
    case "init":
      process.exitCode = runInit(flags, env);
      return;
    case "mcp":
      process.exitCode = runMcp();
      return;
    case "verify":
      process.exitCode = await runVerifyCommand(flags, env);
      return;
    case "watch":
      process.exitCode = await runWatchCommand(flags, env);
      return;
    case "agent-stop":
      process.exitCode = await runAgentStopCommand(flags, env);
      return;
    case "check":
      process.exitCode = await runCheck(flags, env);
      maybeShowFeedbackPrompt(flags, env);
      return;
    case "pilot":
      process.exitCode = await runPilot(flags, env);
      return;
    case "pilot-packet":
      process.exitCode = await runPilotPacket(flags, env);
      return;
    case "observe":
      process.exitCode = await runObserve(flags, env);
      maybeShowFeedbackPrompt(flags, env);
      return;
    case "verify-savings":
      process.exitCode = runVerifySavingsCommand(flags, env);
      return;
    case "validate-specs":
      process.exitCode = runValidateSpecs(flags);
      return;
    case "verify-workflow":
      process.exitCode = flags.enforce === true ? runVerifyEnforceWorkflow(flags, env) : runVerifyWorkflow(flags, env);
      return;
    case "gate":
      process.exitCode = await runGateCommand(flags, env);
      return;
    case "enforce-misses":
      process.exitCode = runEnforceMisses(flags, env);
      return;
    case "coverage":
      process.exitCode = runCoverageCommand(flags, env);
      return;
    case "outcomes":
      process.exitCode = runOutcomesCommand(flags, env);
      return;
    case "version":
      console.log(observerIdentity().version);
      return;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const command = process.argv[2];
  const message = error instanceof Error ? error.message : String(error);
  if (command === "observe") {
    // Reaching here means a defect outside observe()'s own guard. It still must not take a build down:
    // the failure is printed, and the exit code stays 0 unless the caller asked otherwise.
    console.error(`DiffCI observer failed: ${message}`);
    process.exitCode = process.argv.includes("--fail-on-error") ? 1 : 0;
    return;
  }
  console.error(`DiffCI ${command ?? "command"} failed: ${message}`);
  process.exitCode = 1;
});
