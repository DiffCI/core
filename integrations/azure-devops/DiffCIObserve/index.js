// SPDX-License-Identifier: MIT
// DiffCIObserve: the Azure Pipelines version of the DiffCI change impact Action and GitLab component.
// Observation only. Runs nothing, skips nothing, changes nothing, sends nothing, and never decides the
// pipeline's result: a DiffCI problem ends the step "succeeded with issues".
//
// No dependencies on purpose (no azure-pipelines-task-lib): it writes Azure Pipelines logging commands
// itself. Restricted command mode is not declared because it refuses task.uploadsummary and
// artifact.upload (microsoft/azure-pipelines-agent, 2026-11-17).
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

/** The CLI release this task was published with. Moved by every release's version bump. */
const DEFAULT_CLI_VERSION = "0.3.56";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const MAX_TESTS_OUTPUT_BYTES = 64 * 1024;

/** Task inputs reach the process as INPUT_<NAME>, upper-cased. */
function readInputs(env) {
  const get = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const flag = (name, fallback) => {
    const value = get(name);
    return value === "" ? fallback : /^true$/i.test(value);
  };
  return {
    repositoryPath: get("repositoryPath") || env.BUILD_SOURCESDIRECTORY || env.SYSTEM_DEFAULTWORKINGDIRECTORY || process.cwd(),
    cliVersion: get("cliVersion") || DEFAULT_CLI_VERSION,
    redactPaths: flag("redactPaths", false),
    uploadArtifact: flag("uploadArtifact", true),
    artifactName: get("artifactName") || "diffci-observation",
    failOnError: flag("failOnError", false),
  };
}

// Logging command escaping, as azure-pipelines-task-lib does it.
const escapeData = (value) => String(value).replace(/%/g, "%AZP25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (value) => escapeData(value).replace(/;/g, "%3B").replace(/]/g, "%5D");

function vso(command, properties, data) {
  const props = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${escapeProperty(value)};`)
    .join("");
  return `##vso[${command}${props ? ` ${props}` : ""}]${escapeData(data ?? "")}`;
}

function observeArgs({ repositoryPath, reportPath, summaryPath, redactPaths }) {
  const args = ["observe", "--no-send", "--repo", repositoryPath, "--out", reportPath, "--summary-out", summaryPath];
  if (redactPaths) args.push("--redact-paths");
  return args;
}

/** cmd.exe quoting for arguments this task builds itself (paths and a checked version). */
function cmdQuote(arg) {
  return /[\s&|<>^"()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * How to start npx. On Windows npx is a .cmd shim that Node no longer spawns without a shell, so it runs
 * through cmd.exe with every argument quoted, the same way DiffCI's MCP launcher does.
 */
function npxInvocation(platform, env, cliVersion, args) {
  const npxArgs = ["--yes", "--ignore-scripts", "--no-audit", "--fund=false", "--package", `@diffci.com/diffci@${cliVersion}`, "diffci", ...args];
  if (platform === "win32") {
    return { command: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", ["npx", ...npxArgs].map(cmdQuote).join(" ")], windowsVerbatimArguments: true };
  }
  return { command: "npx", args: npxArgs, windowsVerbatimArguments: false };
}

/**
 * Output variables from a report, matching the Action's outputs. fullSuiteRequired is "false" only for a
 * clean SELECTIVE observation, so a pipeline that narrows on it falls back whenever DiffCI is unsure.
 */
function outputsFor(report) {
  const result = report && report.status === "OBSERVED" ? report.result : undefined;
  const narrowable = Boolean(
    result && result.mode === "SELECTIVE" && !result.blindSpot &&
      !(report.nonInterference && report.nonInterference.worktreeUnchanged === false) && Array.isArray(result.selectedTests),
  );
  let reason = "";
  if (!report) reason = "DiffCI wrote no report";
  else if (!result) reason = report.reason || `${String(report.status).toLowerCase()} at ${report.stage}`;
  else if (!narrowable) reason = (result.fallbackReasons && result.fallbackReasons[0]) || (result.blindSpot ? "no test files were discovered" : "the full suite is needed");
  const redacted = Boolean(report && report.payload && report.payload.pathRedaction);
  let affectedTests = "";
  if (narrowable && !redacted) {
    const json = JSON.stringify(result.selectedTests);
    if (Buffer.byteLength(json) <= MAX_TESTS_OUTPUT_BYTES) affectedTests = json;
  }
  return {
    status: report ? String(report.status) : "ERROR",
    fullSuiteRequired: narrowable ? "false" : "true",
    affectedTests,
    affectedTestCount: result ? String((result.selectedTests || []).length) : "",
    totalTestCount: result && result.totalTestCount !== undefined ? String(result.totalTestCount) : "",
    reason: String(reason).replace(/\s+/g, " ").trim(),
  };
}

/**
 * The whole task, with its effects injected so tests can drive it. Returns the exit code; every line it
 * writes goes through `write`.
 */
function run(deps) {
  const { env, platform, write, spawn = spawnSync } = deps;
  const inputs = readInputs(env);
  const finish = (ok, message) => {
    if (ok) return 0;
    write(vso("task.logissue", { type: inputs.failOnError ? "error" : "warning" }, `DiffCI: ${message}`));
    write(vso("task.complete", { result: inputs.failOnError ? "Failed" : "SucceededWithIssues" }, message));
    return inputs.failOnError ? 1 : 0;
  };

  if (!SEMVER.test(inputs.cliVersion)) return finish(false, `cliVersion must be an exact version such as ${DEFAULT_CLI_VERSION}, not "${inputs.cliVersion}"`);

  // The CLI runs outside the checkout, so the project's lockfile and node_modules are never touched.
  const work = mkdtempSync(join(env.AGENT_TEMPDIRECTORY || tmpdir(), "diffci-"));
  const outDir = join(work, "out");
  mkdirSync(outDir);
  const reportPath = join(outDir, "diffci-observation.json");
  const summaryPath = join(outDir, "diffci-summary.md");
  const invocation = npxInvocation(platform, env, inputs.cliVersion, observeArgs({ ...inputs, reportPath, summaryPath }));
  write(`DiffCI ${inputs.cliVersion}: observing ${inputs.repositoryPath}`);
  const child = spawn(invocation.command, invocation.args, {
    cwd: work,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    env: { ...env, DIFFCI_SURFACE: "azure-devops-task", npm_config_update_notifier: "false" },
  });

  let report;
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = undefined; }
  }
  const outputs = outputsFor(report);
  for (const [name, value] of Object.entries(outputs)) write(vso("task.setvariable", { variable: name, isOutput: "true" }, value));
  if (existsSync(summaryPath)) write(vso("task.uploadsummary", {}, summaryPath));
  if (inputs.uploadArtifact && report) write(vso("artifact.upload", { containerfolder: inputs.artifactName, artifactname: inputs.artifactName }, outDir));

  if (child.error) {
    const missing = child.error.code === "ENOENT";
    return finish(false, missing ? "npx was not found. Add a UseNode@1 step (Node.js 20 or later) before this task." : `could not start the DiffCI CLI: ${child.error.message}`);
  }
  if (!report) return finish(false, `the DiffCI CLI exited with code ${child.status} and wrote no report`);
  if (outputs.status !== "OBSERVED") return finish(false, `observation ${outputs.status.toLowerCase()}: ${outputs.reason}`);
  write(`DiffCI: ${outputs.fullSuiteRequired === "false" ? `${outputs.affectedTestCount} of ${outputs.totalTestCount} test files affected` : `full suite needed (${outputs.reason})`}. See the Extensions tab for the summary.`);
  return 0;
}

module.exports = { DEFAULT_CLI_VERSION, readInputs, vso, observeArgs, npxInvocation, outputsFor, run };

if (require.main === module) {
  process.exitCode = run({ env: process.env, platform: process.platform, write: (line) => process.stdout.write(`${line}\n`) });
}
