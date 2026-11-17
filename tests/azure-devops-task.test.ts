// SPDX-License-Identifier: MIT
// DiffCIObserve, the Azure Pipelines task (2026-11-17). Its promises: it never decides the pipeline's
// result unless failOnError is on, it never narrows on a doubtful report, and it only ever starts the
// pinned CLI outside the checkout.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const task = require("../integrations/azure-devops/DiffCIObserve/index.js") as {
  DEFAULT_CLI_VERSION: string;
  readInputs(env: Record<string, string | undefined>): Record<string, unknown>;
  vso(command: string, properties: Record<string, string | undefined>, data?: string): string;
  npxInvocation(platform: string, env: Record<string, string | undefined>, version: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments: boolean };
  outputsFor(report: unknown): Record<string, string>;
  run(deps: { env: Record<string, string | undefined>; platform: string; write: (line: string) => void; spawn?: unknown }): number;
};

const SELECTIVE = { status: "OBSERVED", result: { mode: "SELECTIVE", selectedTests: ["a.test.ts", "b.test.ts"], totalTestCount: 10, fallbackReasons: [] }, nonInterference: { worktreeUnchanged: true } };

describe("Azure DevOps task: metadata", () => {
  it("defaults to the CLI release it ships with, and the manifests agree", () => {
    const { version } = JSON.parse(readFileSync("packages/diffci-cli/package.json", "utf8")) as { version: string };
    assert.equal(task.DEFAULT_CLI_VERSION, version);
    const extension = JSON.parse(readFileSync("integrations/azure-devops/vss-extension.json", "utf8"));
    const manifest = JSON.parse(readFileSync("integrations/azure-devops/DiffCIObserve/task.json", "utf8"));
    assert.equal(extension.version, version);
    assert.equal(extension.public, false, "public only after the private run passes");
    assert.deepEqual(Object.keys(manifest.execution), ["Node24", "Node20_1"]);
    assert.equal(manifest.restrictions, undefined, "restricted mode would refuse uploadsummary and artifact.upload");
    const inputs = new Set(manifest.inputs.map((input: { name: string }) => input.name));
    for (const name of ["repositoryPath", "cliVersion", "redactPaths", "uploadArtifact", "artifactName", "failOnError"]) assert.ok(inputs.has(name), name);
    assert.deepEqual(manifest.outputVariables.map((v: { name: string }) => v.name), Object.keys(task.outputsFor(SELECTIVE)));
  });
});

describe("Azure DevOps task: helpers", () => {
  it("escapes logging command data and properties the way the agent decodes them", () => {
    assert.equal(task.vso("task.setvariable", { variable: "reason", isOutput: "true" }, "a;b]\n100%"), "##vso[task.setvariable variable=reason;isOutput=true;]a;b]%0A100%AZP25");
    assert.equal(task.vso("task.complete", { result: "x;y]" }, ""), "##vso[task.complete result=x%3By%5D;]");
  });

  it("reads inputs with safe defaults", () => {
    const inputs = task.readInputs({ BUILD_SOURCESDIRECTORY: "/s" });
    assert.deepEqual(inputs, { repositoryPath: "/s", cliVersion: task.DEFAULT_CLI_VERSION, redactPaths: false, uploadArtifact: true, artifactName: "diffci-observation", failOnError: false });
    assert.equal(task.readInputs({ INPUT_FAILONERROR: "True", INPUT_UPLOADARTIFACT: "false" }).failOnError, true);
  });

  it("starts the pinned CLI through npx, quoted through cmd.exe on Windows", () => {
    const posix = task.npxInvocation("linux", {}, "1.2.3", ["observe", "--repo", "/a b"]);
    assert.equal(posix.command, "npx");
    assert.deepEqual(posix.args.slice(0, 7), ["--yes", "--ignore-scripts", "--no-audit", "--fund=false", "--package", "@diffci.com/diffci@1.2.3", "diffci"]);
    const windows = task.npxInvocation("win32", { ComSpec: "C:\\Windows\\cmd.exe" }, "1.2.3", ["observe", "--repo", "D:\\a b\\s"]);
    assert.equal(windows.command, "C:\\Windows\\cmd.exe");
    assert.deepEqual(windows.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(windows.args[3]!, /^npx --yes .* diffci observe --repo "D:\\a b\\s"$/);
    assert.equal(windows.windowsVerbatimArguments, true);
  });

  it("narrows only on a clean selective observation", () => {
    assert.deepEqual(task.outputsFor(SELECTIVE), { status: "OBSERVED", fullSuiteRequired: "false", affectedTests: '["a.test.ts","b.test.ts"]', affectedTestCount: "2", totalTestCount: "10", reason: "" });
    assert.equal(task.outputsFor({ ...SELECTIVE, nonInterference: { worktreeUnchanged: false } }).fullSuiteRequired, "true");
    assert.equal(task.outputsFor({ ...SELECTIVE, payload: { pathRedaction: true } }).affectedTests, "");
    const full = task.outputsFor({ status: "OBSERVED", result: { mode: "FULL", selectedTests: [], totalTestCount: 10, fallbackReasons: ["config changed"] } });
    assert.deepEqual([full.fullSuiteRequired, full.reason], ["true", "config changed"]);
    const refused = task.outputsFor({ status: "REFUSED", stage: "range", reason: "set fetchDepth: 0" });
    assert.deepEqual([refused.status, refused.fullSuiteRequired, refused.affectedTestCount, refused.reason], ["REFUSED", "true", "", "set fetchDepth: 0"]);
    assert.deepEqual([task.outputsFor(undefined).status, task.outputsFor(undefined).reason], ["ERROR", "DiffCI wrote no report"]);
  });
});

describe("Azure DevOps task: run", () => {
  function harness(report: unknown, options: { env?: Record<string, string>; spawnError?: NodeJS.ErrnoException; exit?: number } = {}) {
    const temp = mkdtempSync(join(tmpdir(), "diffci-ado-"));
    const lines: string[] = [];
    const calls: Array<{ command: string; args: string[]; cwd: string; surface: string | undefined }> = [];
    const spawn = (command: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
      calls.push({ command, args, cwd: opts.cwd, surface: opts.env.DIFFCI_SURFACE });
      if (options.spawnError) return { error: options.spawnError, status: null };
      const out = args[args.indexOf("--out") + 1]!;
      const summary = args[args.indexOf("--summary-out") + 1]!;
      if (report !== undefined) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(report));
        writeFileSync(summary, "# DiffCI\n");
      }
      return { status: options.exit ?? 0 };
    };
    const code = task.run({ env: { AGENT_TEMPDIRECTORY: temp, BUILD_SOURCESDIRECTORY: "/repo", ...options.env }, platform: "linux", write: (line) => lines.push(line), spawn });
    rmSync(temp, { recursive: true, force: true });
    return { code, lines, calls, temp };
  }

  it("observes outside the checkout, sets outputs, shows the summary and keeps the report", () => {
    const { code, lines, calls, temp } = harness(SELECTIVE);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.cwd.startsWith(temp), "the CLI runs in the agent's temp directory, not the checkout");
    assert.equal(calls[0]!.surface, "azure-devops-task");
    assert.ok(calls[0]!.args.includes("--no-send"));
    assert.ok(lines.includes("##vso[task.setvariable variable=fullSuiteRequired;isOutput=true;]false"));
    assert.ok(lines.some((line) => line.startsWith("##vso[task.uploadsummary]") && line.endsWith("diffci-summary.md")));
    assert.ok(lines.some((line) => line.startsWith("##vso[artifact.upload containerfolder=diffci-observation;artifactname=diffci-observation;]")));
    assert.ok(!lines.some((line) => line.startsWith("##vso[task.complete")), "a clean observation leaves the step's result alone");
  });

  it("ends a refusal as succeeded with issues, never failed", () => {
    const { code, lines } = harness({ status: "REFUSED", stage: "range", reason: "set fetchDepth: 0" });
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.startsWith("##vso[task.logissue type=warning;]") && line.includes("fetchDepth: 0")));
    assert.ok(lines.some((line) => line.startsWith("##vso[task.complete result=SucceededWithIssues;]")));
  });

  it("fails the step only when failOnError is on", () => {
    const { code, lines } = harness({ status: "ERROR", stage: "graph", reason: "boom" }, { env: { INPUT_FAILONERROR: "true" } });
    assert.equal(code, 1);
    assert.ok(lines.some((line) => line.startsWith("##vso[task.complete result=Failed;]")));
  });

  it("says to add UseNode@1 when npx is missing, and still never fails the pipeline", () => {
    const missing = Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
    const { code, lines } = harness(undefined, { spawnError: missing });
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes("UseNode@1")));
    assert.ok(lines.includes("##vso[task.setvariable variable=fullSuiteRequired;isOutput=true;]true"));
  });

  it("reports a CLI that wrote nothing", () => {
    const { code, lines } = harness(undefined, { exit: 2 });
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes("exited with code 2 and wrote no report")));
  });

  it("refuses a cliVersion that is not an exact version, before starting anything", () => {
    const { code, lines, calls } = harness(SELECTIVE, { env: { INPUT_CLIVERSION: "latest" } });
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.ok(lines.some((line) => line.includes("cliVersion must be an exact version")));
  });
});
