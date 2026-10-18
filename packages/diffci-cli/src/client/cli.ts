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
 *   check              analysis plus automatic paired runtime measurement
 *   observe            analyse the checkout and write an observation report
 *   verify-savings     run a paired full-versus-selected timing check
 *   validate-specs     block conflicting same-turn change specifications
 *   verify-workflow    check that a DiffCI job in this repository's workflows cannot affect other jobs
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { observe, isInsideRepository } from "./observe.js";
import { inferFullCommand, inferComparableSelectedCommand, inferWorkspaceComparison } from "./full-command.js";
import { addDiffciPackageScripts, detectPackageManager, installDiffci, type SupportedPackageManager } from "./install.js";
import type { ObservationReport, WorkflowFinding } from "./report.js";
import { submitObservation } from "./submit.js";
import { githubDeliveryWarning } from "./delivery-warning.js";
import { sendUsageSignal } from "./usage-signal.js";
import { detectSpecificationConflicts, readSpecificationFile } from "./spec-conflicts.js";
import { formatVerificationSummary, verificationExitCode, verifyChanged, verifyRange } from "./verify.js";
import { formatGrowthPrompt, formatVerifySavingsSummary, measureCommand, runVerifySavings, writeVerifySavingsReport, type VerifySavingsOptions } from "./verify-savings.js";
import { auditWorkflows, isNonInterfering } from "./workflow-guard.js";
import { buildPilotWorkflow, renderPilotPacket } from "./pilot-packet.js";

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

/**
 * The observer's own version and commit. Found by walking up from this file rather than by a fixed
 * relative path, because this module runs both from source (tsx, depth src/client) and from compiled
 * output (node, depth dist-client/src/client) and a hardcoded `../..` is right in exactly one of them.
 */
function observerIdentity(): { version: string; root?: string; sha?: string } {
  let current = dirname(import.meta.filename);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (parsed.name === "@diffci/observer") return { version: parsed.version ?? "0.0.0", root: current };
        if (parsed.name === "@diffci.com/diffci" || parsed.name === "diffci") {
          let sha: string | undefined;
          try {
            const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
              cwd: current,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            const packageRoot = resolve(current);
            const normalizedGitRoot = resolve(gitRoot);
            const rootsMatch = process.platform === "win32"
              ? packageRoot.toLowerCase() === normalizedGitRoot.toLowerCase()
              : packageRoot === normalizedGitRoot;
            if (rootsMatch) {
              sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: current, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
            }
          } catch {
            // Installed from a tarball rather than a checkout: there is no commit to report, and
            // inventing one would be worse than the field being absent.
          }
          return { version: parsed.version ?? "0.0.0", root: current, sha };
        }
      } catch {
        // Keep walking - an unreadable package.json above us says nothing about ours.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { version: "0.0.0" };
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

What this does:

- snapshots staged, unstaged, and non-ignored untracked changes;
- selects and runs the minimum executable test verification, broadening to the full test command when uncertain;
- exits zero only when the exact snapshot passes and remains unchanged during verification;
- emits a versioned machine-readable receipt and sends nothing.

If verification changes generated files, review those changes and rerun DiffCI so the new snapshot is verified.
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

function diffciWorkflow(version: string): string {
  return `name: DiffCI observation
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci:
    runs-on: ubuntu-24.04
    continue-on-error: true
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # immutable checkout pin
        with:
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # immutable setup-node pin
        with:
          node-version: 22
      - run: npx "@diffci.com/diffci@${version}" observe --no-send
`;
}

function diffciVerificationWorkflow(version: string): string {
  return `name: DiffCI verification
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci-verify:
    name: DiffCI verification
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # immutable checkout pin
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # immutable setup-node pin
        with:
          node-version: 22
      - name: Verify changed code
        run: npx "@diffci.com/diffci@${version}" verify --json --out "$RUNNER_TEMP/diffci-verification.json"
      - name: Upload verification receipt
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: diffci-verification-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/diffci-verification.json
          if-no-files-found: warn
`;
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

  console.log(`DiffCI initialized for AI coding agents in ${repoPath}`);
  for (const write of writes) console.log(`  ${write}`);
  if (installed) console.log(`  ${installed}`);
  else console.log("  skipped package installation (pass --install to add an exact dev dependency)");
  if (!includeWorkflow) console.log("  skipped .github/workflows/diffci.yml (pass --workflow to add it)");
  if (!includeVerificationWorkflow) console.log("  skipped .github/workflows/diffci-verify.yml (pass --verification-workflow to add it)");
  console.log(`\nDefault agent command: ${agentCommand}`);
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

async function runVerifyCommand(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<number> {
  const changed = flags.changed === true;
  if (changed && (flags.base !== undefined || flags.head !== undefined)) {
    console.error("diffci verify accepts either --changed or --base/--head, not both");
    return 2;
  }
  const repoPath = resolve(stringFlag(flags, "repo") ?? env.GITHUB_WORKSPACE ?? process.cwd());
  const out = stringFlag(flags, "out");
  const reportPath = out ? resolve(out) : undefined;
  if (reportPath && (reportPath === repoPath || isInsideRepository(repoPath, reportPath))) {
    console.error(`Refusing to write the verification receipt inside the repository: ${reportPath}. Use --out with a path outside the checkout.`);
    return 2;
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
  };
  const report = changed
    ? await verifyChanged(common)
    : await verifyRange({
        ...common,
        baseOverride: stringFlag(flags, "base"),
        headOverride: stringFlag(flags, "head"),
      });
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
    lines.push(`  graph: ${result.graph.nodes} nodes, confidence ${result.graph.effectiveConfidence ?? result.graph.confidence}`);
    if (result.fallbackReasons.length > 0) {
      lines.push(`  fallback: ${result.fallbackReasons.join("; ")}`);
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
  if (blocking.length > 0) {
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
  const observationCode = await runObserve({ ...flags, out: reportPath, quiet: true, "no-send": true }, env);
  if (observationCode !== 0) return observationCode;
  const observation = JSON.parse(readFileSync(reportPath, "utf8")) as ObservationReport;
  if ((flags["share-usage"] === true || env.DIFFCI_SHARE_USAGE === "1") && flags["no-send"] !== true) {
    await sendUsageSignal({ command: "check", outcome: observation.status === "OBSERVED" ? "observed" : observation.status === "REFUSED" ? "refused" : "error", version: observerIdentity().version });
  }
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
  const report = await observe({
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
  });

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if ((flags["share-usage"] === true || env.DIFFCI_SHARE_USAGE === "1") && flags["no-send"] !== true) {
    await sendUsageSignal({ command: "observe", outcome: report.status === "OBSERVED" ? "observed" : report.status === "REFUSED" ? "refused" : "error", version: identity.version });
  }

  const summary = summarise(report);
  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.quiet !== true) {
    console.log(summary);
    console.log(`  report: ${reportPath}`);
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
      writeFileSync(
        env.GITHUB_STEP_SUMMARY,
        `### DiffCI (observation only)\n\n\`\`\`\n${summary}${delivery ? `\n  delivery: ${delivery}` : ""}\n\`\`\`\n\n[Open-source engine: DiffCI/core](https://github.com/DiffCI/core)\n`,
        { flag: "a" },
      );
    } catch {
      // Losing the summary is cosmetic; the report on disk is the record.
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
    console.log("No job runs the DiffCI action. Add one before starting the observation window.");
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
  diffci init [--repo <path>] [--workflow] [--verification-workflow] [--install] [--force]
  diffci mcp
  diffci verify [--changed | --base <sha> --head <sha>] [--repo <path>] [--out <file>] [--json]
                [--redact-paths] [--timeout-ms <ms>]
  diffci check [--repo <path>] [--out <file>] [--base <sha> --head <sha>]
               [--redact-paths] [--json] [--quiet] [--fail-on-error] [--timeout-ms <ms>] [--share-usage]
  diffci pilot --full <command> [--selected <command>] [--repo <path>] [--out-dir <dir>] [--label <name>]
  diffci pilot-packet [--repo <path>] [--out-dir <dir>] [--base <sha> --head <sha>]
                      [--label <name>] [--repository-url <https-url>] [--redact-paths]
  diffci observe [--repo <path>] [--out <file>] [--base <sha> --head <sha>]
                 [--redact-paths] [--json] [--quiet] [--fail-on-error]
                 [--api-url <url> --api-token <token>] [--no-send] [--share-usage]
  diffci verify-savings --repo <path> --full <command>
                         (--selected <command> | --selected-from-report <file>)
                         --out <file> [--markdown <file>] [--label <name>]
                         [--repetitions <1-20>] [--cache-state cold|warm|unknown]
                         [--cache-prepare <command>] [--fixed-order]
  diffci validate-specs --file <json> [--json]
  diffci verify-workflow [--repo <path>]
  diffci version

init writes AGENTS.md, CLAUDE.md, Cursor rules, Copilot instructions, and diffci.config.json.
--workflow adds a separate non-blocking observation workflow. --install detects npm, pnpm, Yarn,
or Bun, installs this DiffCI version as an exact dev dependency, updates the manager's lockfile,
and adds diffci:verify, diffci:check, and diffci:observe package scripts without replacing existing scripts.
--verification-workflow adds a blocking GitHub check that uploads a commit-bound verification receipt.
mcp runs the stdio MCP server for native agent integrations.
verify --changed snapshots staged, unstaged, and non-ignored untracked changes, runs the minimum
executable verification (or full fallback), and exits zero only when that exact snapshot passes.
verify without --changed resolves the CI event range (or HEAD^..HEAD locally), requires a clean checkout,
and exits zero only when the analyzed head is the commit that actually passed verification.
check analyzes the change, runs inferred full and selected commands, and shows measured savings.
pilot runs observe and verify-savings together, writing reports to ../diffci-output by default.
pilot-packet writes a shareable compatibility summary, raw observation, and non-blocking workflow
outside the checkout. It runs no tests, modifies no target-repository files, and sends nothing.
observe analyses the checkout and writes one JSON report. It runs nothing and changes nothing.
verify-savings runs both commands and reports measured paired runtime; it is an opt-in pilot command.
validate-specs checks an explicit list of specification IDs and logical targets and blocks duplicates.
verify-workflow checks that the job running DiffCI cannot affect any other job, and exits 1 if it can.

The report is sent only when both --api-url and --api-token are given (or DIFFCI_API_URL and
DIFFCI_TOKEN are set). A failed send is reported and never fails the step - the report is on disk
either way. Plain http is refused; the token is never printed.
--share-usage (or DIFFCI_SHARE_USAGE=1) sends only command, outcome, and version to DiffCI.
No repository, commit, test, report, or persistent identifier is sent. --no-send disables it.
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);
  const env = process.env;

  if (flags.help === true || command === "help" || command === undefined) {
    console.log(USAGE);
    process.exitCode = command === undefined ? 1 : 0;
    return;
  }

  switch (command) {
    case "init":
      process.exitCode = runInit(flags, env);
      return;
    case "mcp":
      process.exitCode = runMcp();
      return;
    case "verify":
      process.exitCode = await runVerifyCommand(flags, env);
      return;
    case "check":
      process.exitCode = await runCheck(flags, env);
      return;
    case "pilot":
      process.exitCode = await runPilot(flags, env);
      return;
    case "pilot-packet":
      process.exitCode = await runPilotPacket(flags, env);
      return;
    case "observe":
      process.exitCode = await runObserve(flags, env);
      return;
    case "verify-savings":
      process.exitCode = runVerifySavingsCommand(flags, env);
      return;
    case "validate-specs":
      process.exitCode = runValidateSpecs(flags);
      return;
    case "verify-workflow":
      process.exitCode = runVerifyWorkflow(flags, env);
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
