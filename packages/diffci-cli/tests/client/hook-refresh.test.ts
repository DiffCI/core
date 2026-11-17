import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { HOOK_MARKER, hookCommandOf, prePushHook, refreshPrePushHook } from "../../src/client/hook.js";

/**
 * Installed hooks are kept current (2026-11-17). The fixture is the hook DentalPresence still had from
 * 8 Nov: it read "DiffCI is not installed" as failing tests and blocked a correct push.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");
const OLD_HOOK = readFileSync(join(ROOT, "tests", "client", "fixtures", "pre-push-2026-11-08.sh"), "utf8");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-hook-refresh-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@diffci.local");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "a.test.js"), "import test from 'node:test'; test('a', () => {});\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function hookPath(dir: string): string {
  return join(dir, ".git", "hooks", "pre-push");
}

function verify(dir: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, "verify", "--repo", dir, "--json", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 300_000, windowsHide: true,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && name !== "CI" && !name.startsWith("GITHUB_"))), DO_NOT_TRACK: "1", ...env },
  });
}

describe("refreshing an installed DiffCI pre-push hook", () => {
  it("reads the command from the 8 Nov hook and from the current one", () => {
    assert.equal(hookCommandOf(OLD_HOOK), "npx --no-install diffci");
    assert.equal(hookCommandOf(prePushHook("pnpm exec diffci")), "pnpm exec diffci");
    assert.equal(hookCommandOf(prePushHook('npx --yes "@diffci.com/diffci@0.3.54"').replace(/\n/g, "\r\n")), 'npx --yes "@diffci.com/diffci@0.3.54"');
  });

  it("replaces an old managed hook with this version's, for the same command, once", () => {
    const dir = repository();
    try {
      mkdirSync(dirname(hookPath(dir)), { recursive: true });
      writeFileSync(hookPath(dir), OLD_HOOK.replace(/\n/g, "\r\n"));
      assert.match(refreshPrePushHook(dir) ?? "", /updated the DiffCI pre-push hook .git\/hooks\/pre-push/);
      const refreshed = readFileSync(hookPath(dir), "utf8");
      assert.equal(refreshed, prePushHook("npx --no-install diffci"));
      assert.match(refreshed, /diffci_runs\(\)/, "the not-installed fix is in");
      assert.equal(refreshPrePushHook(dir), undefined, "a current hook is left as it is");
      assert.deepEqual(readdirSync(dirname(hookPath(dir))).filter((name) => name.startsWith("pre-push.diffci-")), [], "no temporary file is left");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never touches a hook DiffCI did not write", () => {
    const dir = repository();
    try {
      const foreign = "#!/bin/sh\nnpx --no-install diffci verify --base \"$base\" --head \"$local_sha\" </dev/null\nexit 0\n";
      writeFileSync(hookPath(dir), foreign);
      assert.equal(refreshPrePushHook(dir), undefined);
      assert.equal(readFileSync(hookPath(dir), "utf8"), foreign);
      assert.ok(!foreign.includes(HOOK_MARKER));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes from verify of the working tree, never from the hook's own range verify or when turned off", () => {
    const dir = repository();
    try {
      writeFileSync(hookPath(dir), OLD_HOOK);
      const head = git(dir, "rev-parse", "HEAD");
      const range = verify(dir, ["--base", `${head}`, "--head", head]);
      assert.doesNotMatch(range.stderr, /updated the DiffCI pre-push hook/);
      assert.equal(readFileSync(hookPath(dir), "utf8"), OLD_HOOK);

      const off = verify(dir, ["--changed"], { DIFFCI_HOOK_REFRESH: "0" });
      assert.equal(off.status, 0, off.stdout + off.stderr);
      assert.equal(readFileSync(hookPath(dir), "utf8"), OLD_HOOK);

      const changed = verify(dir, ["--changed"]);
      assert.equal(changed.status, 0, changed.stdout + changed.stderr);
      assert.match(changed.stderr, /updated the DiffCI pre-push hook/);
      assert.equal(readFileSync(hookPath(dir), "utf8"), prePushHook("npx --no-install diffci"));
      assert.equal(JSON.parse(changed.stdout).verification, "passed", "stdout stays the receipt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never fails verification when the hook cannot be refreshed", () => {
    const dir = repository();
    try {
      mkdirSync(hookPath(dir), { recursive: true });
      writeFileSync(join(hookPath(dir), HOOK_MARKER.replace(/\W/g, "")), "");
      const run = verify(dir, ["--staged"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.doesNotMatch(run.stderr, /updated the DiffCI pre-push hook/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
