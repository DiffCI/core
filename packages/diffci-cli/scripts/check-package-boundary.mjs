#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteWindowsArg(value) {
  const text = String(value);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function runNpm(args) {
  if (process.platform !== "win32") {
    return execFileSync(npm, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  const command = [npm, ...args].map(quoteWindowsArg).join(" ");
  return execFileSync("cmd.exe", ["/d", "/s", "/c", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

assert(packageJson.name === "@diffci.com/diffci", "package name must remain @diffci.com/diffci");
assert(packageJson.private === false, "published CLI must not be private");
assert(packageJson.publishConfig?.access === "public", "published CLI must declare public access");
assert(packageJson.repository?.url === "git+https://github.com/DiffCI/core.git", "CLI repository must point to public Core");
assert(packageJson.repository?.directory === "packages/diffci-cli", "CLI repository directory must be explicit");
assert(packageJson.bugs?.url === "https://github.com/DiffCI/core/issues", "CLI issue tracker must point to Core");
assert(!JSON.stringify(packageJson).includes("github.com/DiffCI/DiffCI.com"), "published CLI metadata must not expose the private product repository");
assert(packageJson.bundleDependencies?.includes("@diffci.com/core"), "CLI tarball must bundle its pinned Core dependency");
assert(packageJson.dependencies?.["@diffci.com/core"]?.startsWith("git+https://github.com/DiffCI/core.git#"), "CLI must pin Core to an immutable public commit");
assert(existsSync(resolve(root, "dist-client/src/client/cli.js")), "build the CLI before checking its package boundary");
assert(existsSync(resolve(root, "dist-client/src/client/mcp.js")), "build the MCP server before checking its package boundary");

const packed = JSON.parse(runNpm(["pack", "--dry-run", "--ignore-scripts", "--json"]))[0];
assert(packed?.version === packageJson.version, "npm pack version must match package.json");
const paths = new Set(packed.files.map((file) => file.path));
for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "dist-client/src/client/cli.js",
  "dist-client/src/client/mcp.js",
  "dist-client/src/preflight/fingerprint.js",
  "dist-client/src/preflight/taxonomy.js",
  "node_modules/@diffci.com/core/dist/index.js",
  "node_modules/@diffci.com/core/dist/repo/impact.js",
]) {
  assert(paths.has(required), `published tarball is missing ${required}`);
}

for (const path of paths) {
  assert(!path.startsWith("src/"), `source file leaked into published CLI tarball: ${path}`);
  assert(!path.startsWith("tests/"), `test file leaked into published CLI tarball: ${path}`);
  assert(!path.startsWith("scripts/"), `release script leaked into published CLI tarball: ${path}`);
  assert(!["package-lock.json", "SOURCE-ARCHIVE.md", "SOURCE-MANIFEST.json"].includes(path), `historical or lockfile artifact leaked into published CLI tarball: ${path}`);
}

console.log(`CLI package boundary passed: ${packed.filename} includes built client/MCP files and bundled Core only.`);
