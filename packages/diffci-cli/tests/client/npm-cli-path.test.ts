import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { npmCliPath } from "../helpers/npm-cli.js";

// cli-agent.test.ts's install test runs the real npm through a shim. It used to look for npm-cli.js
// under `npm root -g`, which is the configured prefix, and failed with "Cannot find module" whenever
// npm's prefix pointed somewhere npm itself is not installed.
it("finds the npm-cli.js npm runs, whatever npm's global prefix is", { skip: process.platform === "win32" ? "where.exe resolves npm.cmd beside its node_modules" : false }, () => {
  const prefix = mkdtempSync(join(tmpdir(), "diffci-npm-prefix-"));
  try {
    const path = npmCliPath({ ...process.env, npm_config_prefix: prefix });
    assert.ok(existsSync(path), `${path} does not exist`);
    assert.match(path, /[\\/]npm-cli\.js$/);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
