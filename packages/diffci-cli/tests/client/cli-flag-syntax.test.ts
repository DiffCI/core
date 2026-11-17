import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function verify(args: string[]) {
  // An empty directory as the repository: a flag that is not read lets verify fail fast there.
  const repo = mkdtempSync(join(tmpdir(), "diffci-flag-syntax-"));
  try {
    return spawnSync(process.execPath, ["--import", "tsx", CLI, "verify", "--repo", repo, "--no-log", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DO_NOT_TRACK: "1" } });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// Before 2026-11-17 `--policy=enforce` was read as a flag named "policy=enforce" and ignored, so verify
// ran without enforcement while `verify-workflow --enforce` counted the job as an enforcing gate.
it("reads --name=value the same as --name value", () => {
  for (const args of [["--policy=bogus"], ["--policy", "bogus"]]) {
    const result = verify(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--policy accepts only "enforce", got "bogus"/, args.join(" "));
  }
  for (const args of [["--shard=3/2"], ["--shard", "3/2"]]) {
    const result = verify(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--shard takes i\/N with 1 <= i <= N, got "3\/2"/, args.join(" "));
  }
});
