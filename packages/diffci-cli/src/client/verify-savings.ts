import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { classifyFailureFromEvidence, computeFailureFingerprint } from "../preflight/fingerprint.js";
import type { FailureClass } from "../preflight/taxonomy.js";

export type CacheState = "cold" | "warm" | "unknown" | "potentially-warmed";
export type FailureAssessmentKind = "none" | "selection_miss" | "likely_flaky" | "pre_existing" | "infrastructure" | "inconclusive";

export interface CommandMeasurement {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface VerifySavingsReport {
  schema: "diffci.verifySavings.v3";
  producedAt: string;
  label?: string;
  cwd: string;
  timeoutMs: number;
  analysisOverheadMs?: number;
  selectionSource: "manual" | "diffci-observation";
  observationReportPath?: string;
  selectedTestCount?: number;
  totalTestCount?: number;
  provenance: SavingsProvenance;
  runnerIdentity: RunnerIdentity;
  protocol: SavingsProtocol;
  trials: SavingsTrial[];
  failureAssessment: FailureAssessment;
  full: CommandMeasurement;
  selected: CommandMeasurement;
  comparison: {
    fullWallMs: number;
    selectedWallMs: number;
    netSelectedMs: number;
    deltaMs: number;
    grossPercentChange: number;
    percentChange: number;
    selectedCommandSucceeded: boolean;
    fullCommandSucceeded: boolean;
    missedFailureSignal: boolean;
    evidenceValid: boolean;
    performanceEvidence: "CONTROLLED" | "PRELIMINARY" | "INVALID";
    repetitions: number;
    fullWallMsRange: { min: number; median: number; max: number };
    selectedWallMsRange: { min: number; median: number; max: number };
  };
  notes: string[];
}

export interface CheckoutSnapshot {
  capturedAt: string;
  headSha?: string;
  worktreeDigest?: string;
  dependencyInputsSha256?: string;
  dependencyInputFiles?: string[];
  resolvedDependencySha256?: string;
  resolvedDependencyFiles?: string[];
}

export interface RunnerIdentity {
  platform: string;
  architecture: string;
  osRelease: string;
  nodeVersion: string;
  cpuModel?: string;
  cpuCount: number;
  totalMemoryBytes: number;
  ci?: string;
  runnerName?: string;
  runnerOs?: string;
  runnerArch?: string;
  runnerEnvironment?: string;
  imageOs?: string;
  imageVersion?: string;
  fingerprintSha256: string;
}

export interface SavingsProtocol {
  repetitions: number;
  alternatingOrder: boolean;
  declaredCacheState: Exclude<CacheState, "potentially-warmed">;
  cachePreparationCommand?: string;
  cacheStateControlled: boolean;
}

export interface SavingsTrial {
  index: number;
  order: ["full" | "selected", "full" | "selected"];
  cacheState: { full: CacheState; selected: CacheState };
  preparations: CommandMeasurement[];
  full: CommandMeasurement;
  selected: CommandMeasurement;
  provenance: SavingsProvenance;
}

export interface FailureEvidenceSummary {
  arm: "full" | "selected";
  trial: number;
  failureClass: FailureClass;
  fingerprint: string;
}

export interface FailureAssessment {
  kind: FailureAssessmentKind;
  confidence: "high" | "medium" | "low" | "not-applicable";
  explanation: string;
  evidence: FailureEvidenceSummary[];
}

export interface SavingsProvenance {
  baseSha?: string;
  headSha?: string;
  observationSha256?: string;
  observerVersion?: string;
  beforeFull: CheckoutSnapshot;
  afterFull: CheckoutSnapshot;
  afterSelected: CheckoutSnapshot;
  snapshots?: CheckoutSnapshot[];
  checkoutStable: boolean;
  invalidReasons: string[];
}

export interface VerifySavingsOptions {
  full: string;
  selected?: string;
  selectedFromReport?: string;
  selectedCommandOverride?: string;
  out: string;
  markdown?: string;
  label?: string;
  cwd: string;
  timeoutMs: number;
  analysisOverheadMs?: number;
  tailBytes: number;
  repetitions?: number;
  cacheState?: Exclude<CacheState, "potentially-warmed">;
  cachePreparationCommand?: string;
  alternateOrder?: boolean;
}

interface ResolvedSelection {
  command: string;
  source: "manual" | "diffci-observation";
  observationReportPath?: string;
  selectedTestCount?: number;
  totalTestCount?: number;
  analysisOverheadMs?: number;
  baseSha?: string;
  headSha?: string;
  observationSha256?: string;
  observerVersion?: string;
}

function tail(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  return value.slice(-bytes);
}

function readSelectionFromObservation(path: string, override?: string): ResolvedSelection {
  const absolutePath = resolve(path);
  const bytes = readFileSync(absolutePath);
  const parsed = JSON.parse(bytes.toString("utf8")) as {
    status?: unknown;
    observer?: { version?: unknown };
    commitRange?: { baseSha?: unknown; headSha?: unknown };
    result?: {
      proposedCommands?: unknown;
      selectedTests?: unknown;
      totalTestCount?: unknown;
    };
    timings?: { totalMs?: unknown };
  };
  if (parsed.status !== "OBSERVED") throw new Error(`--selected-from-report requires an OBSERVED report; got ${String(parsed.status)}`);
  const commands = parsed.result?.proposedCommands;
  if (!Array.isArray(commands) || commands.some(command => typeof command !== "string" || !command.trim()) || (commands.length !== 1 && !override)) {
    throw new Error("--selected-from-report requires exactly one non-empty proposed command; use --selected with an explicit command covering the complete selection for multi-command plans");
  }
  const command = override ?? commands[0];
  const selectedTests = Array.isArray(parsed.result?.selectedTests) ? parsed.result.selectedTests : undefined;
  return {
    command,
    source: "diffci-observation",
    observationReportPath: absolutePath,
    selectedTestCount: selectedTests?.length,
    totalTestCount: typeof parsed.result?.totalTestCount === "number" ? parsed.result.totalTestCount : undefined,
    analysisOverheadMs: typeof parsed.timings?.totalMs === "number" ? parsed.timings.totalMs : undefined,
    baseSha: typeof parsed.commitRange?.baseSha === "string" ? parsed.commitRange.baseSha : undefined,
    headSha: typeof parsed.commitRange?.headSha === "string" ? parsed.commitRange.headSha : undefined,
    observationSha256: createHash("sha256").update(bytes).digest("hex"),
    observerVersion: typeof parsed.observer?.version === "string" ? parsed.observer.version : undefined,
  };
}

const DEPENDENCY_INPUT_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "pom.xml", "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "gradle.lockfile",
  "go.mod", "go.sum", "go.work", "go.work.sum", "cargo.toml", "cargo.lock", "pyproject.toml", "poetry.lock",
  "pipfile", "pipfile.lock", "uv.lock", "gemfile", "gemfile.lock", "composer.json", "composer.lock",
]);

const RESOLVED_DEPENDENCY_MARKERS = [
  "node_modules/.package-lock.json",
  "node_modules/.modules.yaml",
  ".pnp.cjs",
  ".pnp.data.json",
  "vendor/composer/installed.json",
];

function gitBuffer(cwd: string, args: string[]): Buffer | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

function nulPaths(buffer: Buffer | undefined): string[] {
  if (!buffer) return [];
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function hashFiles(cwd: string, paths: readonly string[], seed: Buffer | string = ""): string {
  const hash = createHash("sha256").update(seed);
  for (const path of [...new Set(paths)].sort()) {
    hash.update("\0path\0").update(path);
    const absolute = resolve(cwd, path);
    try {
      const stat = lstatSync(absolute);
      hash.update(stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other");
      if (stat.isFile() || stat.isSymbolicLink()) hash.update(readFileSync(absolute));
    } catch {
      hash.update("missing");
    }
  }
  return hash.digest("hex");
}

function dirtyContentDigest(cwd: string, status: Buffer): string {
  const modified = nulPaths(gitBuffer(cwd, ["ls-files", "-m", "-o", "--exclude-standard", "-z"]));
  const staged = nulPaths(gitBuffer(cwd, ["diff", "--cached", "--name-only", "-z"]));
  return hashFiles(cwd, [...modified, ...staged], status);
}

function dependencyInputs(cwd: string): { files: string[]; sha256: string } | undefined {
  const listed = nulPaths(gitBuffer(cwd, ["ls-files", "-c", "-o", "--exclude-standard", "-z"]));
  if (!listed.length) return undefined;
  const files = listed.filter((path) => {
    if (path.split(/[\\/]/).includes("node_modules")) return false;
    const name = basename(path).toLowerCase();
    return DEPENDENCY_INPUT_NAMES.has(name) || /^requirements(?:[-_.].+)?\.txt$/i.test(name);
  }).sort();
  return { files, sha256: hashFiles(cwd, files, "diffci-dependency-inputs-v1") };
}

function resolvedDependencyMarkers(cwd: string): { files: string[]; sha256: string } | undefined {
  const files = RESOLVED_DEPENDENCY_MARKERS.filter((path) => existsSync(resolve(cwd, path)));
  return files.length ? { files, sha256: hashFiles(cwd, files, "diffci-resolved-dependencies-v1") } : undefined;
}

function checkoutSnapshot(cwd: string): CheckoutSnapshot {
  const capturedAt = new Date().toISOString();
  try {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    const dependencies = dependencyInputs(cwd);
    const resolved = resolvedDependencyMarkers(cwd);
    return {
      capturedAt,
      headSha,
      worktreeDigest: dirtyContentDigest(cwd, status),
      dependencyInputsSha256: dependencies?.sha256,
      dependencyInputFiles: dependencies?.files,
      resolvedDependencySha256: resolved?.sha256,
      resolvedDependencyFiles: resolved?.files,
    };
  } catch {
    return { capturedAt };
  }
}

function buildProvenance(
  selection: ResolvedSelection,
  beforeFull: CheckoutSnapshot,
  afterFull: CheckoutSnapshot,
  afterSelected: CheckoutSnapshot,
  snapshots: CheckoutSnapshot[] = [beforeFull, afterFull, afterSelected],
): SavingsProvenance {
  const invalidReasons: string[] = [];
  const expectedHeadSha = selection.headSha ?? (selection.source === "manual" ? beforeFull.headSha : undefined);
  if (snapshots.some(snapshot => !snapshot.headSha || !snapshot.worktreeDigest)) invalidReasons.push("checkout identity could not be captured for every execution boundary");
  if (expectedHeadSha && snapshots.some(snapshot => snapshot.headSha !== expectedHeadSha)) invalidReasons.push("executed checkout HEAD did not match the bound head SHA at every boundary");
  if (!expectedHeadSha) invalidReasons.push("no head SHA was available to bind the execution");
  if (new Set(snapshots.map(snapshot => snapshot.headSha)).size !== 1) invalidReasons.push("checkout HEAD changed during paired execution");
  if (new Set(snapshots.map(snapshot => snapshot.worktreeDigest)).size !== 1) invalidReasons.push("worktree changed during paired execution");
  if (snapshots.some(snapshot => !snapshot.dependencyInputsSha256)) invalidReasons.push("dependency input identity could not be captured for every execution boundary");
  if (new Set(snapshots.map(snapshot => snapshot.dependencyInputsSha256)).size !== 1) invalidReasons.push("dependency manifests or lockfiles changed during paired execution");
  const resolved = snapshots.map(snapshot => snapshot.resolvedDependencySha256);
  if (resolved.some(Boolean) && (resolved.some(value => !value) || new Set(resolved).size !== 1)) invalidReasons.push("resolved dependency markers changed during paired execution");
  return {
    baseSha: selection.baseSha,
    headSha: expectedHeadSha,
    observationSha256: selection.observationSha256,
    observerVersion: selection.observerVersion,
    beforeFull,
    afterFull,
    afterSelected,
    snapshots,
    checkoutStable: invalidReasons.length === 0,
    invalidReasons,
  };
}

function resolveSelection(options: VerifySavingsOptions): ResolvedSelection {
  if (options.selectedFromReport) {
    return readSelectionFromObservation(options.selectedFromReport, options.selectedCommandOverride);
  }
  if (!options.selected) throw new Error("--selected <command> or --selected-from-report <path> is required");
  return { command: options.selected, source: "manual" };
}

function captureRunnerIdentity(env: NodeJS.ProcessEnv = process.env): RunnerIdentity {
  const identity = {
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    nodeVersion: process.version,
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    ci: env.GITHUB_ACTIONS === "true" ? "github-actions" : env.CI ? String(env.CI) : undefined,
    runnerName: env.RUNNER_NAME,
    runnerOs: env.RUNNER_OS,
    runnerArch: env.RUNNER_ARCH,
    runnerEnvironment: env.RUNNER_ENVIRONMENT,
    imageOs: env.ImageOS,
    imageVersion: env.ImageVersion,
  };
  return {
    ...identity,
    fingerprintSha256: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

function range(values: readonly number[]): { min: number; median: number; max: number } {
  if (!values.length) return { min: 0, median: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
}

function failureEvidence(measurement: CommandMeasurement, arm: "full" | "selected", trial: number): FailureEvidenceSummary | undefined {
  if (measurement.exitCode === 0 && !measurement.timedOut) return undefined;
  const errorText = `${measurement.stderrTail}\n${measurement.stdoutTail}`.trim() || `exit ${String(measurement.exitCode)}`;
  const failureClass = measurement.timedOut
    ? "TIMEOUT"
    : classifyFailureFromEvidence({ jobName: `verify-savings:${arm}`, command: measurement.command, errorText });
  return {
    arm,
    trial,
    failureClass,
    // The arm is reported separately. Keep it out of the normalized fingerprint so
    // an identical repository failure in both arms can be recognized as pre-existing.
    fingerprint: computeFailureFingerprint({ failureClass, jobName: "verify-savings", errorText }),
  };
}

function assessFailures(trials: readonly SavingsTrial[]): FailureAssessment {
  const evidence = trials.flatMap((trial) => [
    failureEvidence(trial.full, "full", trial.index),
    failureEvidence(trial.selected, "selected", trial.index),
  ]).filter((value): value is FailureEvidenceSummary => value !== undefined);
  if (!evidence.length) return { kind: "none", confidence: "not-applicable", explanation: "Every measured arm passed.", evidence };

  const fullPasses = trials.map((trial) => trial.full.exitCode === 0 && !trial.full.timedOut);
  const selectedPasses = trials.map((trial) => trial.selected.exitCode === 0 && !trial.selected.timedOut);
  const varying = (values: readonly boolean[]): boolean => new Set(values).size > 1;
  if (varying(fullPasses) || varying(selectedPasses)) {
    return { kind: "likely_flaky", confidence: trials.length >= 3 ? "medium" : "low", explanation: "At least one arm changed pass/fail outcome across repeated executions.", evidence };
  }
  if (evidence.some((item) => item.failureClass === "RUNNER_INFRASTRUCTURE" || item.failureClass === "TIMEOUT")) {
    return { kind: "infrastructure", confidence: "medium", explanation: "Failure output matched a narrow timeout or runner-infrastructure signature.", evidence };
  }

  const fullFailures = evidence.filter((item) => item.arm === "full");
  const selectedFailures = evidence.filter((item) => item.arm === "selected");
  const stableFull = fullFailures.length === trials.length && new Set(fullFailures.map((item) => item.fingerprint)).size === 1;
  const stableSelected = selectedFailures.length === trials.length && new Set(selectedFailures.map((item) => item.fingerprint)).size === 1;
  if (stableFull && selectedFailures.length === 0) {
    if (trials.length >= 3) {
      return { kind: "selection_miss", confidence: "high", explanation: "The full arm reproduced the same failure in at least three trials while every selected arm passed. Inspect the omitted test before treating the selection as safe.", evidence };
    }
    return { kind: "inconclusive", confidence: "low", explanation: "The full arm failed while the selected arm passed, but fewer than three repetitions cannot separate a stable miss from a flake.", evidence };
  }
  if (stableFull && stableSelected && fullFailures[0]?.fingerprint === selectedFailures[0]?.fingerprint) {
    return { kind: "pre_existing", confidence: trials.length >= 2 ? "medium" : "low", explanation: "Both arms reproduced the same normalized failure signature; it is shared rather than evidence of an omitted-test miss.", evidence };
  }
  return { kind: "inconclusive", confidence: "low", explanation: "The failures were not stable enough to classify conservatively.", evidence };
}

export function measureCommand(command: string, options: Pick<VerifySavingsOptions, "cwd" | "timeoutMs" | "tailBytes">): CommandMeasurement {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  // Match the shell used by Windows package scripts, including && short-circuiting
  // and native exit codes; Windows PowerShell 5 cannot execute those chains.
  const shellCommand = process.platform === "win32" ? "cmd.exe" : "sh";
  const shellArgv = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const result = spawnSync(shellCommand, shellArgv, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    windowsVerbatimArguments: process.platform === "win32",
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      npm_config_yes: "true",
    },
  });
  const finishedAt = new Date().toISOString();
  return {
    command,
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    startedAt,
    finishedAt,
    wallMs: Date.now() - started,
    stdoutTail: tail(result.stdout ?? "", options.tailBytes),
    stderrTail: tail(result.stderr ?? "", options.tailBytes),
  };
}

export function buildVerifySavingsReport(input: {
  producedAt?: string;
  label?: string;
  cwd: string;
  timeoutMs: number;
  analysisOverheadMs?: number;
  selection: Omit<ResolvedSelection, "command" | "analysisOverheadMs">;
  full: CommandMeasurement;
  selected: CommandMeasurement;
  provenance?: SavingsProvenance;
  runnerIdentity?: RunnerIdentity;
  protocol?: SavingsProtocol;
  trials?: SavingsTrial[];
  failureAssessment?: FailureAssessment;
}): VerifySavingsReport {
  const defaultProtocol: SavingsProtocol = {
    repetitions: 1,
    alternatingOrder: false,
    declaredCacheState: "unknown",
    cacheStateControlled: false,
  };
  const protocol = input.protocol ?? defaultProtocol;
  const provenance = input.provenance ?? {
    beforeFull: { capturedAt: input.full.startedAt },
    afterFull: { capturedAt: input.full.finishedAt },
    afterSelected: { capturedAt: input.selected.finishedAt },
    checkoutStable: false,
    invalidReasons: ["checkout provenance was not captured"],
  };
  const trials = input.trials ?? [{
    index: 1,
    order: ["full", "selected"],
    cacheState: { full: "unknown", selected: "potentially-warmed" },
    preparations: [],
    full: input.full,
    selected: input.selected,
    provenance,
  } satisfies SavingsTrial];
  const fullRange = range(trials.map((trial) => trial.full.wallMs));
  const selectedRange = range(trials.map((trial) => trial.selected.wallMs));
  const overhead = input.analysisOverheadMs ?? 0;
  const netSelectedMs = selectedRange.median + overhead;
  const deltaMs = fullRange.median - netSelectedMs;
  const grossPercentChange = fullRange.median > 0 ? ((fullRange.median - selectedRange.median) / fullRange.median) * 100 : 0;
  const percentChange = fullRange.median > 0 ? (deltaMs / fullRange.median) * 100 : 0;
  const fullCommandSucceeded = trials.every((trial) => trial.full.exitCode === 0 && !trial.full.timedOut);
  const selectedCommandSucceeded = trials.every((trial) => trial.selected.exitCode === 0 && !trial.selected.timedOut);
  const missedFailureSignal = trials.some((trial) => (trial.full.exitCode !== 0 || trial.full.timedOut) && trial.selected.exitCode === 0 && !trial.selected.timedOut);
  const preparationsSucceeded = trials.every((trial) => trial.preparations.every((preparation) => preparation.exitCode === 0 && !preparation.timedOut));
  // A suspended runner or clock discontinuity can exceed spawnSync's active timeout
  // while the child still exits zero. Such elapsed times cannot establish savings.
  const elapsedTimesValid = trials.every((trial) => [...trial.preparations, trial.full, trial.selected]
    .every((measurement) => Number.isFinite(measurement.wallMs) && measurement.wallMs >= 0 && (input.timeoutMs === 0 || measurement.wallMs <= input.timeoutMs)));
  const evidenceValid = fullCommandSucceeded && selectedCommandSucceeded && provenance.checkoutStable && preparationsSucceeded && elapsedTimesValid;
  const performanceEvidence = !evidenceValid
    ? "INVALID"
    : protocol.repetitions >= 3 && protocol.alternatingOrder && protocol.cacheStateControlled
      ? "CONTROLLED"
      : "PRELIMINARY";
  const failureAssessment = input.failureAssessment ?? assessFailures(trials);

  const notes = [
    "This is paired runtime evidence, not a production-savings claim.",
    "Full and selected commands were run sequentially in the same checkout.",
    input.analysisOverheadMs === undefined
      ? "No analysis overhead was provided, so net selected runtime equals selected command runtime."
      : "Net selected runtime includes DiffCI analysis overhead.",
  ];
  notes.push(performanceEvidence === "CONTROLLED"
    ? "Runtime evidence used at least three alternating, cache-prepared repetitions."
    : "Runtime evidence is preliminary until at least three alternating, cache-prepared repetitions agree.");
  if (missedFailureSignal) notes.push("Full failed while selected passed; inspect outputs before treating the selection as safe.");
  if (!elapsedTimesValid) notes.push("Timing invalid: elapsed wall time is outside the configured timeout bounds; runner suspension or a clock discontinuity may have occurred.");
  if (input.provenance && !input.provenance.checkoutStable) notes.push(`Checkout provenance invalid: ${input.provenance.invalidReasons.join("; ")}.`);

  return {
    schema: "diffci.verifySavings.v3",
    producedAt: input.producedAt ?? new Date().toISOString(),
    label: input.label,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    analysisOverheadMs: input.analysisOverheadMs,
    selectionSource: input.selection.source,
    observationReportPath: input.selection.observationReportPath,
    selectedTestCount: input.selection.selectedTestCount,
    totalTestCount: input.selection.totalTestCount,
    provenance,
    runnerIdentity: input.runnerIdentity ?? captureRunnerIdentity(),
    protocol,
    trials,
    failureAssessment,
    full: input.full,
    selected: input.selected,
    comparison: {
      fullWallMs: fullRange.median,
      selectedWallMs: selectedRange.median,
      netSelectedMs,
      deltaMs,
      grossPercentChange,
      percentChange,
      selectedCommandSucceeded,
      fullCommandSucceeded,
      missedFailureSignal,
      evidenceValid,
      performanceEvidence,
      repetitions: trials.length,
      fullWallMsRange: fullRange,
      selectedWallMsRange: selectedRange,
    },
    notes,
  };
}

function formatMs(ms: number): string {
  if (Math.abs(ms) < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function formatGrowthPrompt(report: VerifySavingsReport): string {
  return report.comparison.evidenceValid && report.comparison.percentChange > 0
    ? "Useful? Star the open-source engine: https://github.com/DiffCI/core"
    : "";
}

export function renderVerifySavingsMarkdown(report: VerifySavingsReport): string {
  const deltaLabel = report.comparison.deltaMs >= 0 ? "faster" : "slower";
  const overhead = report.analysisOverheadMs === undefined ? "not provided" : formatMs(report.analysisOverheadMs);
  const title = report.label ? `# DiffCI Verify Savings: ${report.label}` : "# DiffCI Verify Savings";
  const warning = report.comparison.missedFailureSignal
    ? "\n> WARNING: Full failed while selected passed. Do not treat this selected command as safe until the full-run failure is understood.\n"
    : !report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded
      ? "\n> WARNING: One or both commands failed. This comparison is invalid as savings evidence; timings below are diagnostic only.\n"
      : !report.comparison.evidenceValid
        ? `\n> WARNING: Checkout provenance validation failed: ${report.provenance.invalidReasons.join("; ")}. Timings are diagnostic only.\n`
      : "";
  const selectionCounts =
    report.selectedTestCount !== undefined && report.totalTestCount !== undefined
      ? `\nSelected tests: ${report.selectedTestCount} of ${report.totalTestCount}\n`
      : "";
  const commandCoverage =
    report.selectionSource === "diffci-observation"
      ? "Selected command came from the observation report. If the repository needs a runner-specific command, rerun with an explicit selected command that covers the complete DiffCI selection."
      : "Selected command was supplied manually. Confirm it covers the complete DiffCI selection before sharing this as maintainer evidence.";
  const nextStep = !report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded
    ? "Inspect the failed command output and rerun before treating this as savings evidence."
    : !report.comparison.evidenceValid
      ? "Fix the checkout/provenance issue and rerun before treating this as savings evidence."
      : report.comparison.performanceEvidence === "CONTROLLED"
        ? "Review the repeated-run distribution and failure assessment before considering a production trial."
        : "Repeat at least three times with alternating order and a cache-preparation command to establish controlled cache state before making a production-savings claim.";

  return `${title}

Produced at: ${report.producedAt}
Repository label: ${report.label ?? "not provided"}
Selection source: ${report.selectionSource}
${selectionCounts}${warning}

This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result

${!report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded ? "Comparison invalid: command failure. Do not interpret the timing difference as savings.\n" : !report.comparison.evidenceValid ? "Comparison invalid: checkout identity changed or could not be verified. Do not interpret the timing difference as savings.\n" : ""}
| Measure | Value |
| --- | ---: |
| Full runtime | ${formatMs(report.comparison.fullWallMs)} |
| Selected runtime | ${formatMs(report.comparison.selectedWallMs)} |
| Test execution change vs full | ${formatPercent(report.comparison.grossPercentChange)} |
| DiffCI analysis overhead | ${overhead} |
| Net selected runtime | ${formatMs(report.comparison.netSelectedMs)} |
| Delta vs full | ${formatMs(report.comparison.deltaMs)} ${deltaLabel} |
| Percent change vs full | ${formatPercent(report.comparison.percentChange)} |
| Runtime evidence | ${report.comparison.performanceEvidence.toLowerCase()} |
| Repetitions | ${report.comparison.repetitions} |
| Full runtime range | ${formatMs(report.comparison.fullWallMsRange.min)} / ${formatMs(report.comparison.fullWallMsRange.median)} / ${formatMs(report.comparison.fullWallMsRange.max)} (min/median/max) |
| Selected runtime range | ${formatMs(report.comparison.selectedWallMsRange.min)} / ${formatMs(report.comparison.selectedWallMsRange.median)} / ${formatMs(report.comparison.selectedWallMsRange.max)} (min/median/max) |

## Measurement Protocol

| Field | Value |
| --- | --- |
| Alternating arm order | ${report.protocol.alternatingOrder ? "yes" : "no"} |
| Declared cache state | ${report.protocol.declaredCacheState} |
| Cache preparation command | ${report.protocol.cachePreparationCommand ? `\`${report.protocol.cachePreparationCommand.replaceAll("|", "\\|")}\`` : "not provided"} |
| Cache state controlled | ${report.protocol.cacheStateControlled ? "yes" : "no"} |

## Failure Assessment

| Field | Value |
| --- | --- |
| Classification | ${report.failureAssessment.kind} |
| Confidence | ${report.failureAssessment.confidence} |
| Explanation | ${report.failureAssessment.explanation} |

## Provenance

| Field | Value |
| --- | --- |
| Base SHA | \`${report.provenance.baseSha ?? "unavailable"}\` |
| Head SHA | \`${report.provenance.headSha ?? "unavailable"}\` |
| Observation SHA-256 | \`${report.provenance.observationSha256 ?? "unavailable"}\` |
| DiffCI observer version | ${report.provenance.observerVersion ?? "unavailable"} |
| Checkout stable across both arms | ${report.provenance.checkoutStable ? "yes" : "no"} |
| Dependency inputs SHA-256 | \`${report.provenance.beforeFull.dependencyInputsSha256 ?? "unavailable"}\` |
| Resolved dependency markers SHA-256 | \`${report.provenance.beforeFull.resolvedDependencySha256 ?? "unavailable"}\` |
| Runner identity SHA-256 | \`${report.runnerIdentity.fingerprintSha256}\` |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | ${report.full.exitCode ?? "signal"} | ${report.full.timedOut ? "yes" : "no"} | \`${report.full.command.replaceAll("|", "\\|")}\` |
| Selected | ${report.selected.exitCode ?? "signal"} | ${report.selected.timedOut ? "yes" : "no"} | \`${report.selected.command.replaceAll("|", "\\|")}\` |

## Maintainer Review

| Question | Answer |
| --- | --- |
| Command coverage | ${commandCoverage} |
| Cache state | ${report.protocol.cacheStateControlled ? `${report.protocol.declaredCacheState}; reset/preparation applied before each arm.` : `${report.protocol.declaredCacheState}; not independently controlled.`} |
| Invalid evidence handling | Failed commands or unstable checkout provenance are labelled diagnostic only above. |
| Next step | ${nextStep} |

## Interpretation Notes

${report.notes.map((note) => `- ${note}`).join("\n")}

Open-source engine: [DiffCI/core](https://github.com/DiffCI/core).
${formatGrowthPrompt(report) ? "\nUseful? [Star DiffCI](https://github.com/DiffCI/core) or [volunteer a pilot repository](https://diffci.com/#pilot).\n" : ""}
`;
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

export function runVerifySavings(options: VerifySavingsOptions): VerifySavingsReport {
  const selection = resolveSelection(options);
  const analysisOverheadMs = options.analysisOverheadMs ?? selection.analysisOverheadMs;
  const repetitions = options.repetitions ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error("--repetitions must be an integer from 1 to 20");
  const declaredCacheState = options.cacheState ?? (options.cachePreparationCommand ? "warm" : "unknown");
  if (!(["cold", "warm", "unknown"] as const).includes(declaredCacheState)) throw new Error("--cache-state must be cold, warm, or unknown");
  const alternatingOrder = options.alternateOrder ?? repetitions > 1;
  const protocol: SavingsProtocol = {
    repetitions,
    alternatingOrder,
    declaredCacheState,
    cachePreparationCommand: options.cachePreparationCommand,
    cacheStateControlled: declaredCacheState !== "unknown" && Boolean(options.cachePreparationCommand),
  };
  const trials: SavingsTrial[] = [];

  for (let index = 0; index < repetitions; index++) {
    const order: SavingsTrial["order"] = alternatingOrder && index % 2 === 1 ? ["selected", "full"] : ["full", "selected"];
    const preparations: CommandMeasurement[] = [];
    const measurements: Partial<Record<"full" | "selected", CommandMeasurement>> = {};
    const snapshots: CheckoutSnapshot[] = [];
    for (const arm of order) {
      if (options.cachePreparationCommand) preparations.push(measureCommand(options.cachePreparationCommand, options));
      snapshots.push(checkoutSnapshot(options.cwd));
      measurements[arm] = measureCommand(arm === "full" ? options.full : selection.command, options);
      snapshots.push(checkoutSnapshot(options.cwd));
    }
    const full = measurements.full!;
    const selected = measurements.selected!;
    const beforeFull = order[0] === "full" ? snapshots[0]! : snapshots[2]!;
    const afterFull = order[0] === "full" ? snapshots[1]! : snapshots[3]!;
    const afterSelected = order[0] === "selected" ? snapshots[1]! : snapshots[3]!;
    const provenance = buildProvenance(selection, beforeFull, afterFull, afterSelected, snapshots);
    const firstState: CacheState = declaredCacheState;
    const secondState: CacheState = options.cachePreparationCommand
      ? declaredCacheState
      : declaredCacheState === "warm"
        ? "warm"
        : "potentially-warmed";
    trials.push({
      index: index + 1,
      order,
      cacheState: order[0] === "full"
        ? { full: firstState, selected: secondState }
        : { selected: firstState, full: secondState },
      preparations,
      full,
      selected,
      provenance,
    });
  }

  const first = trials[0]!;
  const allSnapshots = trials.flatMap((trial) => trial.provenance.snapshots ?? []);
  const provenance = buildProvenance(selection, first.provenance.beforeFull, first.provenance.afterFull, first.provenance.afterSelected, allSnapshots);
  return buildVerifySavingsReport({
    label: options.label,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    analysisOverheadMs,
    selection,
    full: first.full,
    selected: first.selected,
    provenance,
    runnerIdentity: captureRunnerIdentity(),
    protocol,
    trials,
    failureAssessment: assessFailures(trials),
  });
}

export function writeVerifySavingsReport(report: VerifySavingsReport, paths: { out: string; markdown?: string }): void {
  writeText(paths.out, `${JSON.stringify(report, null, 2)}\n`);
  if (paths.markdown) writeText(paths.markdown, renderVerifySavingsMarkdown(report));
}

export function formatVerifySavingsSummary(report: VerifySavingsReport): string {
  if (!report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded) {
    return "DiffCI verify-savings: comparison invalid because one or both commands failed" +
      `\n  failure assessment: ${report.failureAssessment.kind} (${report.failureAssessment.confidence}) - ${report.failureAssessment.explanation}` +
      (report.comparison.missedFailureSignal ? "\n  warning: full failed while selected passed; inspect outputs before claiming safety" : "");
  }
  if (!report.comparison.evidenceValid) {
    if (!report.provenance.checkoutStable) return `DiffCI verify-savings: comparison invalid because checkout provenance failed\n  ${report.provenance.invalidReasons.join("; ")}`;
    return `DiffCI verify-savings: comparison invalid\n  ${report.notes.find(note => note.startsWith("Timing invalid:")) ?? "Cache preparation failed."}`;
  }
  const lines = [
    `DiffCI verify-savings: ${report.comparison.performanceEvidence === "CONTROLLED" ? "controlled repeated" : "preliminary"} test execution ${Math.abs(report.comparison.grossPercentChange).toFixed(1)}% ${report.comparison.grossPercentChange >= 0 ? "faster" : "slower"} (${report.comparison.repetitions} ${report.comparison.repetitions === 1 ? "trial" : "trials"})`,
    `  full: ${formatMs(report.comparison.fullWallMs)}`,
    `  selected: ${formatMs(report.comparison.selectedWallMs)} + analysis ${formatMs(report.analysisOverheadMs ?? 0)} = ${formatMs(report.comparison.netSelectedMs)}`,
    `  net including analysis: ${Math.abs(report.comparison.percentChange).toFixed(1)}% ${report.comparison.deltaMs >= 0 ? "faster" : "slower"} (${formatMs(Math.abs(report.comparison.deltaMs))} ${report.comparison.deltaMs >= 0 ? "saved" : "added"})`,
    `  cache: ${report.protocol.declaredCacheState}${report.protocol.cacheStateControlled ? " (prepared before each arm)" : " (not controlled)"}`,
  ];
  if (report.comparison.missedFailureSignal) {
    lines.push("  warning: full failed while selected passed; inspect outputs before claiming safety");
  }
  return lines.join("\n");
}
