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

// `--changed=true` was stored as the string "true", and on/off flags are read with `=== true`, so the
// flag was off with no error. Two scope flags together are rejected, which shows whether it was read.
it("reads --flag=true as the flag and --flag=false as leaving it off", () => {
  for (const args of [["--changed=true", "--paths", "a"], ["--changed", "--paths", "a"]]) {
    const result = verify(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /accepts one of --changed, --staged, --paths\/--paths-from or --base\/--head; got --changed and --paths/, args.join(" "));
  }
  const off = verify(["--changed=false", "--paths", "a"]);
  assert.doesNotMatch(off.stderr, /accepts one of --changed/);
});

it("preserves boolean-looking values for string options", () => {
  for (const value of ["false", "true"]) {
    for (const args of [[`--policy=${value}`], ["--policy", value]]) {
      const result = verify(args);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, new RegExp(`--policy accepts only "enforce", got "${value}"`));
    }
  }
  const refs = verify(["--head=true", "--base=false", "--changed"]);
  assert.match(refs.stderr, /got --changed and --base\/--head/);
});

it("rejects empty inline values instead of interpreting them as zero or defaults", () => {
  for (const name of ["timeout-ms", "policy", "head", "paths"]) {
    const result = verify([`--${name}=`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`--${name} requires a value`));
  }
});

it("rejects an on/off flag with an inline value other than true or false", () => {
  const result = verify(["--changed=yes"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--changed is an on\/off flag; use --changed, --changed=true or --changed=false/);
});
