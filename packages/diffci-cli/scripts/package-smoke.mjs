#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteWindowsArg(value) {
  const text = String(value);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function runNpm(args, options = {}) {
  if (process.platform !== "win32") return run(npm, args, options);
  const command = [npm, ...args].map(quoteWindowsArg).join(" ");
  return run("cmd.exe", ["/d", "/s", "/c", command], options);
}

function write(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function git(repo, args) {
  return run("git", args, { cwd: repo });
}

function createFixture(parent) {
  const repo = join(parent, "fixture");
  mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "test@diffci.local"]);
  git(repo, ["config", "user.name", "DiffCI package smoke"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  write(join(repo, "package.json"), `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  write(join(repo, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }, null, 2)}\n`);
  write(join(repo, "src", "alpha.js"), "export const alpha = () => 1;\n");
  write(join(repo, "src", "beta.js"), "export const beta = () => 2;\n");
  write(join(repo, "test", "alpha.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { alpha } from '../src/alpha.js'; test('alpha', () => assert.equal(alpha(), 1));\n");
  write(join(repo, "test", "beta.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { beta } from '../src/beta.js'; test('beta', () => assert.equal(beta(), 2));\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "initial"]);
  const base = git(repo, ["rev-parse", "HEAD"]).trim();
  write(join(repo, "src", "alpha.js"), "export const alpha = () => 42;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "change alpha"]);
  return { repo, base, head: git(repo, ["rev-parse", "HEAD"]).trim() };
}

async function assertMcpInitialize(packageRoot, expectedVersion) {
  const mcp = spawn(process.execPath, [join(packageRoot, "dist-client", "src", "client", "mcp.js")], {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  mcp.stderr.setEncoding("utf8");
  mcp.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    const response = await new Promise((resolveResponse, rejectResponse) => {
      let stdout = "";
      const timeout = setTimeout(() => rejectResponse(new Error(`MCP initialize timed out: ${stderr}`)), 10_000);
      mcp.once("error", (error) => {
        clearTimeout(timeout);
        rejectResponse(error);
      });
      mcp.once("close", (code) => {
        clearTimeout(timeout);
        rejectResponse(new Error(`MCP exited before initialize (code ${code}): ${stderr}`));
      });
      mcp.stdout.setEncoding("utf8");
      mcp.stdout.on("data", (chunk) => {
        stdout += chunk;
        while (true) {
          const newline = stdout.indexOf("\n");
          if (newline === -1) return;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line);
            if (message.id === 1) {
              clearTimeout(timeout);
              resolveResponse(message);
              return;
            }
          } catch {
            // MCP stderr is reserved for diagnostics; ignore any unrelated stdout line here.
          }
        }
      });
      mcp.stdin.end(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "diffci-package-smoke", version: "1.0.0" } },
      })}\n`);
    });
    assert(response.result?.serverInfo?.name === "diffci-mcp", `expected DiffCI MCP server, got ${JSON.stringify(response.result?.serverInfo)}`);
    assert(response.result?.serverInfo?.version === expectedVersion, `expected MCP version ${expectedVersion}, got ${response.result?.serverInfo?.version ?? "none"}`);
  } finally {
    mcp.stdin.end();
    if (mcp.exitCode === null) mcp.kill();
    await new Promise((resolveClose) => {
      if (mcp.exitCode !== null) return resolveClose();
      const timeout = setTimeout(resolveClose, 1_000);
      mcp.once("close", () => {
        clearTimeout(timeout);
        resolveClose();
      });
    });
  }
}

const temp = mkdtempSync(join(tmpdir(), "diffci-cli-package-smoke-"));
try {
  runNpm(["run", "build"]);
  const pack = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp]))[0];
  const tarball = join(temp, pack.filename);
  assert(existsSync(tarball), `npm pack did not create ${tarball}`);
  assert(pack.files.some((file) => file.path === "node_modules/@diffci.com/core/dist/index.js"), "packed CLI must include Core");

  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  runNpm(["init", "--yes"], { cwd: consumer, stdio: "ignore" });
  runNpm(["install", "--ignore-scripts", "--no-audit", "--fund=false", tarball], { cwd: consumer, stdio: "inherit" });
  const bundledCoreLocations = [
    join(consumer, "node_modules", "@diffci.com", "core", "dist", "index.js"),
    join(consumer, "node_modules", "@diffci.com", "diffci", "node_modules", "@diffci.com", "core", "dist", "index.js"),
  ];
  const bundledCoreIndex = bundledCoreLocations.find(existsSync);
  assert(bundledCoreIndex, "consumer did not receive bundled Core");
  assert(existsSync(join(consumer, "node_modules", ".bin", process.platform === "win32" ? "diffci.cmd" : "diffci")), "consumer did not receive diffci binary");
  assert(existsSync(join(consumer, "node_modules", ".bin", process.platform === "win32" ? "diffci-mcp.cmd" : "diffci-mcp")), "consumer did not receive diffci-mcp binary");
  const version = runNpm(["exec", "--", "diffci", "version"], { cwd: consumer }).trim();
  assert(version === pack.version, `expected installed CLI ${pack.version}, got ${version}`);
  await assertMcpInitialize(join(consumer, "node_modules", "@diffci.com", "diffci"), pack.version);

  const fixture = createFixture(temp);
  const reportPath = join(temp, "report.json");
  runNpm(["exec", "--", "diffci", "observe", "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--out", reportPath, "--json", "--no-send"], { cwd: consumer });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert(report.status === "OBSERVED", `expected OBSERVED report, got ${report.status}`);
  assert(report.result?.mode === "SELECTIVE", `expected a selective fixture result, got ${report.result?.mode}`);
  assert(report.result?.selectedTests?.includes("test/alpha.test.js"), `alpha test was not selected: ${JSON.stringify(report.result?.selectedTests)}`);
  assert(report.nonInterference?.worktreeUnchanged === true, "installed CLI changed the observed checkout");

  // Exercise the new parser dependency from the installed tarball, with a plan from the installed
  // `diffci plan` for the same fixture. Keep inputs outside the checkout so plan creation still sees a
  // clean repository.
  const planPath = join(temp, "plan.json");
  const installedCli = join(consumer, "node_modules", "@diffci.com", "diffci", "dist-client", "src", "client", "cli.js");
  const planArgs = ["plan", "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head];
  const planJson = run(process.execPath, [installedCli, ...planArgs], { cwd: consumer });
  const plan = JSON.parse(planJson).plan;
  assert(plan?.selectedTests?.includes("test/alpha.test.js"), "installed diffci plan did not select alpha");
  assert(plan?.skippedTests?.includes("test/beta.test.js"), "installed diffci plan did not skip beta");
  const corePlanJson = run(process.execPath, [join(dirname(bundledCoreIndex), "cli.js"), ...planArgs], { cwd: consumer });
  // Analysis timing is the only field allowed to differ between two runs.
  const withoutTiming = (text) => { const value = JSON.parse(text); delete value.impact?.performance; return JSON.stringify(value); };
  assert(withoutTiming(planJson) === withoutTiming(corePlanJson), "installed diffci plan differs from the bundled Core plan");
  write(planPath, planJson);
  const resultsPath = join(temp, "junit.xml");
  const selectedFailure = '<testcase name="selected" file="test/alpha.test.js"><failure/></testcase>';
  const missedFailure = '<testcase name="missed" file="test/beta.test.js"><failure/></testcase>';
  const unknownFailure = '<testcase name="unattributed"><error/></testcase>';
  const commandEnv = { ...process.env };
  delete commandEnv.NODE_TEST_CONTEXT;
  for (const scenario of [
    { name: "mixed", cases: selectedFailure + missedFailure + unknownFailure, exitCode: 1, summary: { failedTests: 3, missed: 0, possibleMisses: 1, preExisting: 0, selected: 1, unattributed: 1 } },
    { name: "pre-existing", cases: missedFailure, base: missedFailure, exitCode: 0, summary: { failedTests: 1, missed: 0, possibleMisses: 0, preExisting: 1, selected: 0, unattributed: 0 } },
    { name: "new-miss", cases: missedFailure, base: '<testcase name="missed" file="test/beta.test.js"/>', exitCode: 1, summary: { failedTests: 1, missed: 1, possibleMisses: 0, preExisting: 0, selected: 0, unattributed: 0 } },
    { name: "selected-only", cases: selectedFailure, exitCode: 0, summary: { failedTests: 1, missed: 0, possibleMisses: 0, preExisting: 0, selected: 1, unattributed: 0 } },
    { name: "unattributed-only", cases: unknownFailure, exitCode: 1, summary: { failedTests: 1, missed: 0, possibleMisses: 0, preExisting: 0, selected: 0, unattributed: 1 } },
  ]) {
    write(resultsPath, `<testsuites><testsuite name="package smoke">${scenario.cases}</testsuite></testsuites>`);
    const basePath = join(temp, "base-junit.xml");
    if (scenario.base) write(basePath, `<testsuites><testsuite name="package smoke">${scenario.base}</testsuite></testsuites>`);
    const comparison = spawnSync(process.execPath, [installedCli, "check-plan", "--plan", planPath, "--results", resultsPath, ...(scenario.base ? ["--base-results", basePath] : [])], {
      cwd: consumer, encoding: "utf8", env: commandEnv, timeout: 30_000,
    });
    assert(!comparison.error, `installed check-plan failed to run: ${comparison.error?.message}`);
    assert(comparison.status === scenario.exitCode, `installed check-plan ${scenario.name} exited ${comparison.status}: ${comparison.stdout}${comparison.stderr}`);
    assert(comparison.stderr === "", `installed check-plan ${scenario.name} wrote stderr: ${comparison.stderr}`);
    const checked = JSON.parse(comparison.stdout);
    assert(checked.schemaVersion === 1 && checked.mode === "SELECTIVE" && checked.fullFallback === false, "installed check-plan returned an unexpected report format");
    for (const [field, expected] of Object.entries(scenario.summary)) {
      assert(checked.summary?.[field] === expected, `installed check-plan ${scenario.name} ${field}: expected ${expected}, got ${checked.summary?.[field]}`);
    }
    for (const group of ["missed", "possibleMisses", "preExisting", "selected", "unattributed"]) assert(checked[group].length === scenario.summary[group], `installed check-plan ${group} disagrees with the summary`);
    console.log(`Installed check-plan smoke: ${JSON.stringify({ scenario: scenario.name, exitCode: comparison.status, summary: checked.summary })}`);
  }
  assert(git(fixture.repo, ["status", "--porcelain"]).trim() === "", "installed check-plan changed the fixture checkout");
  console.log(`CLI package smoke passed: ${pack.filename} installed into a clean consumer, observed a fixture repository and checked JUnit failures.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
