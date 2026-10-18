#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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
  assert(bundledCoreLocations.some(existsSync), "consumer did not receive bundled Core");
  assert(existsSync(join(consumer, "node_modules", ".bin", process.platform === "win32" ? "diffci.cmd" : "diffci")), "consumer did not receive diffci binary");
  assert(existsSync(join(consumer, "node_modules", ".bin", process.platform === "win32" ? "diffci-mcp.cmd" : "diffci-mcp")), "consumer did not receive diffci-mcp binary");
  const version = runNpm(["exec", "--", "diffci", "version"], { cwd: consumer }).trim();
  assert(version === pack.version, `expected installed CLI ${pack.version}, got ${version}`);

  const fixture = createFixture(temp);
  const reportPath = join(temp, "report.json");
  runNpm(["exec", "--", "diffci", "observe", "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--out", reportPath, "--json", "--no-send"], { cwd: consumer });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert(report.status === "OBSERVED", `expected OBSERVED report, got ${report.status}`);
  assert(report.result?.mode === "SELECTIVE", `expected a selective fixture result, got ${report.result?.mode}`);
  assert(report.result?.selectedTests?.includes("test/alpha.test.js"), `alpha test was not selected: ${JSON.stringify(report.result?.selectedTests)}`);
  assert(report.nonInterference?.worktreeUnchanged === true, "installed CLI changed the observed checkout");
  console.log(`CLI package smoke passed: ${pack.filename} installed into a clean consumer and observed a fixture repository.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
