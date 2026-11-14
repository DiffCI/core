import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    const build = spawnSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.client.json",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );

    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stdout + build.stderr);

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
  });
});
