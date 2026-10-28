// SPDX-License-Identifier: MIT
// Uses Muse itself to verify (or regenerate) the package-tree digest required by its marketplace.
// Usage: MUSE_BIN=/path/to/muse node scripts/check-muse-plugin-integrity.mjs [--write]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--write")) {
  throw new Error("Usage: node scripts/check-muse-plugin-integrity.mjs [--write]");
}
const write = args[0] === "--write";

const museBin = process.env.MUSE_BIN || "muse";
const isolatedStore = mkdtempSync(join(tmpdir(), "diffci-muse-integrity-"));

try {
  // A local package install calculates Muse's canonical full-tree digest without running the
  // plugin. Keep its cache and configuration out of a developer's normal Muse installation.
  const installed = spawnSync(museBin, ["plugins", "install", "integrations/muse-plugin", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_DATA_HOME: join(isolatedStore, "data"),
      XDG_CONFIG_HOME: join(isolatedStore, "config"),
    },
  });
  if (installed.error) {
    throw new Error(`Could not run Muse at ${museBin}: ${installed.error.message}`);
  }
  if (installed.status !== 0) {
    throw new Error(`Muse package validation failed (exit ${installed.status ?? "unknown"}):\n${installed.stderr || installed.stdout}`);
  }

  let receipt;
  try {
    receipt = JSON.parse(installed.stdout);
  } catch (error) {
    throw new Error(`Muse did not return an install receipt as JSON: ${error.message}`);
  }
  const digest = receipt?.installed?.package_sha256;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Muse install receipt did not include a valid package_sha256.");
  }

  const marketplacePath = resolve(root, "marketplace.json");
  const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
  const plugin = marketplace.plugins?.find((entry) => entry.name === "diffci");
  if (!plugin) throw new Error("Muse marketplace does not list the DiffCI plugin.");

  const recorded = plugin.integrity?.digest;
  if (write) {
    plugin.integrity = { ...plugin.integrity, digest };
    writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
    console.log(`Updated Muse marketplace digest to ${digest}.`);
  } else if (recorded !== digest) {
    throw new Error(
      `Muse marketplace digest is ${recorded ?? "missing"}, but its packaged plugin is ${digest}. ` +
      "Run this command again with --write and commit marketplace.json before tagging a release.",
    );
  } else {
    console.log(`Muse marketplace digest matches the packaged plugin: ${digest}.`);
  }
} finally {
  rmSync(isolatedStore, { recursive: true, force: true, maxRetries: 3 });
}
