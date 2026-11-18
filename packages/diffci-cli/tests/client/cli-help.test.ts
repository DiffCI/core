import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildClient } from "../helpers/build-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "dist-client", "src", "client", "cli.js");

// TODO: Update this list whenever a CLI command is added.
const COMMANDS = [
  "check-plan",
  "plan",
  "red-builds",
  "telemetry",
  "init",
  "mcp",
  "verify",
  "watch",
  "agent-stop",
  "check",
  "pilot",
  "pilot-packet",
  "observe",
  "verify-savings",
  "validate-specs",
  "verify-workflow",
  "gate",
  "enforce-misses",
  "coverage",
  "outcomes",
  "version",
];

describe("CLI help", () => {
  it("lists every CLI command", () => {
    buildClient();

    const result = spawnSync(process.execPath, [CLI, "help"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    for (const command of COMMANDS) {
      assert.ok(
        result.stdout.includes(`diffci ${command}`),
        `Help output is missing command: diffci ${command}`,
      );
    }

    // Usage counting is on by default and only DO_NOT_TRACK=1, DIFFCI_NO_SEND=1 or
    // DIFFCI_SHARE_USAGE=0 stop it (docs/telemetry.md), so the old opt-in flag does nothing.
    assert.ok(!result.stdout.includes("--share-usage"), "help lists --share-usage, which no code reads");
    assert.ok(result.stdout.includes("DIFFCI_SHARE_USAGE=0"), "help names the environment switch that stops counting");
  });
});
