import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearGitLocationEnvironment, HOOK_MARKER, hookCommand, installHint, installPrePushHook, prePushHook } from "../../src/client/hook.js";
import { selectionInstruction, type AgentSelectionPlan } from "../../src/client/agent-selection.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-hook-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@diffci.local", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "base"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@diffci.local", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "head"], { cwd: dir });
  return dir;
}

test("the hook command is pinned or uses the installed binary", () => {
  assert.equal(hookCommand(undefined, "1.2.3"), 'npx --yes "@diffci.com/diffci@1.2.3"');
  assert.equal(hookCommand("pnpm", "1.2.3"), "pnpm exec diffci");
});

test("the hook names the install step for the command it runs", () => {
  assert.match(installHint(hookCommand("npm", "1.2.3")), /\(npm ci\)$/);
  assert.match(installHint(hookCommand("pnpm", "1.2.3")), /\(pnpm install\)$/);
  assert.match(installHint(hookCommand("yarn", "1.2.3")), /\(yarn install\)$/);
  assert.match(installHint(hookCommand("bun", "1.2.3")), /\(bun install\)$/);
  assert.match(installHint(hookCommand(undefined, "1.2.3")), /registry/);
  assert.match(prePushHook("npx --no-install diffci"), /npx --no-install diffci version >\/dev\/null/);
});

test("installs into the hooks directory and keeps a hook it did not write", () => {
  const dir = repo();
  try {
    assert.match(installPrePushHook(dir, "diffci", false), /^wrote \.git\/hooks\/pre-push/);
    assert.match(installPrePushHook(dir, "diffci", false), /^kept .*\(current\)/);
    writeFileSync(join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\necho mine\n");
    assert.match(installPrePushHook(dir, "diffci", false), /existing hook not written by DiffCI/);
    assert.equal(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8"), "#!/bin/sh\necho mine\n");
    assert.match(installPrePushHook(dir, "diffci", true), /^wrote/);
    // core.hooksPath (husky and similar) is respected.
    execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: dir });
    assert.match(installPrePushHook(dir, "diffci", false), /^wrote \.husky\/pre-push/);
    assert.ok(readFileSync(join(dir, ".husky", "pre-push"), "utf8").includes(HOOK_MARKER));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("blocks a push when verification fails, and lets it through when DiffCI cannot verify", () => {
  const dir = repo();
  try {
    const log = join(dir, "calls.log");
    const fake = join(dir, "fake-diffci.mjs");
    // `version` is the hook's "does DiffCI start" check; it always succeeds here and is not logged.
    writeFileSync(fake, `import { appendFileSync } from "node:fs";\nif (process.argv[2] === "version") process.exit(0);\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(Number(process.env.FAKE_CODE));\n`);
    const hook = join(dir, "pre-push");
    writeFileSync(hook, prePushHook(`node ${JSON.stringify(fake).replace(/\\\\/g, "/")}`));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const base = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: dir, encoding: "utf8" }).trim();
    const push = (code: number, strict = false, report: Record<string, string> = {}) => spawnSync("sh", [hook, "origin", "url"], {
      cwd: dir, encoding: "utf8", input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
      env: { ...process.env, FAKE_CODE: String(code), DIFFCI_HOOK_STRICT: strict ? "1" : "", DIFFCI_API_URL: "", DIFFCI_TOKEN: "", ...report },
    });
    assert.equal(push(0).status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`verify --base ${base} --head ${head}`]);
    const failed = push(1);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /push blocked/);
    assert.equal(push(2).status, 0);
    assert.equal(push(2, true).status, 1);
    // With a report destination, the pushed range is also observed and sent; a failed send never blocks.
    writeFileSync(log, "");
    assert.equal(push(0, false, { DIFFCI_API_URL: "https://example.invalid/v1", DIFFCI_TOKEN: "t" }).status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`verify --base ${base} --head ${head}`, `observe --base ${base} --head ${head} --quiet`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the MCP selection leads with the one exact command to run", () => {
  const plan = {
    status: "planned", selection: "selected", tests_selected: 3, tests_available: 580,
    command: "npx tsx --test src/a.test.ts", reason: "dependency impact", checks: [],
  } as unknown as AgentSelectionPlan;
  assert.equal(selectionInstruction(plan), "DiffCI selected 3 of 580 test files. Run exactly:\nnpx tsx --test src/a.test.ts\nDo not substitute your own test files, checks or the full suite.");
  const full = { ...plan, selection: "full", command: "npm test", reason: "full verification required: Lockfile changed" } as unknown as AgentSelectionPlan;
  assert.match(selectionInstruction(full), /^DiffCI requires the full suite \(full verification required: Lockfile changed\)\. Run exactly:\nnpm test/);
  const blocked = { ...plan, status: "blocked", reason: "working tree changed during analysis; reanalyze" } as unknown as AgentSelectionPlan;
  assert.match(selectionInstruction(blocked), /^DiffCI could not plan this change/);
});

test("clears git's repository-location variables, and keeps CI's GIT_CONFIG_* authentication", () => {
  const env: NodeJS.ProcessEnv = { GIT_DIR: "/r/.git/worktrees/w", GIT_INDEX_FILE: "/r/i", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", PATH: "/bin" };
  assert.deepEqual(clearGitLocationEnvironment(env), ["GIT_DIR", "GIT_INDEX_FILE"]);
  assert.deepEqual(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", PATH: "/bin" });
});

test("a push from a linked worktree cannot reach the repository through the hook's GIT_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "diffci-hook-worktree-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@diffci.local", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  try {
    const main = join(root, "main");
    execFileSync("git", ["init", "--quiet", "--bare", join(root, "remote.git")]);
    execFileSync("git", ["init", "--quiet", main]);
    git(main, "commit", "--quiet", "--allow-empty", "-m", "base");
    git(main, "remote", "add", "origin", join(root, "remote.git").replace(/\\/g, "/"));
    git(main, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    // Stands in for DiffCI running a test suite whose tests create their own repositories, as DentalPresence's do.
    const log = join(root, "seen.log");
    const fake = join(root, "fake-diffci.mjs");
    writeFileSync(fake, [
      `import { execFileSync } from "node:child_process";`,
      `import { appendFileSync, mkdtempSync } from "node:fs";`,
      `import { tmpdir } from "node:os";`,
      `import { join } from "node:path";`,
      `if (process.argv[2] === "version") process.exit(0);`,
      `appendFileSync(${JSON.stringify(log)}, (process.env.GIT_DIR ?? "-") + "\\n");`,
      `execFileSync("git", ["init", "--quiet"], { cwd: mkdtempSync(join(tmpdir(), "diffci-hook-test-repo-")) });`,
    ].join("\n"));
    const hook = (content: string) => writeFileSync(join(main, ".git", "hooks", "pre-push"), content);
    const pushFromWorktree = (name: string) => {
      const tree = join(root, name);
      // The branch exists on the remote first, so the worktree's push has a base and the hook verifies it.
      git(main, "push", "--quiet", "origin", `HEAD:refs/heads/${name}`);
      git(main, "worktree", "add", "--quiet", "-b", name, tree);
      git(tree, "commit", "--quiet", "--allow-empty", "-m", name);
      git(tree, "push", "--quiet", "origin", `HEAD:refs/heads/${name}`);
      return git(main, "config", "--get", "core.bare");
    };
    const command = `node ${JSON.stringify(fake.replace(/\\/g, "/"))}`;

    // Without the unset line (the 0.3.63 hook), the stand-in's git init marks the real repository bare.
    hook(prePushHook(command).replace(/^unset GIT_DIR .*\n/m, ""));
    assert.equal(pushFromWorktree("old"), "true", "the test would not catch the leak");
    git(main, "config", "core.bare", "false");

    hook(prePushHook(command));
    assert.equal(pushFromWorktree("new"), "false");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((line) => line === "-" ? "-" : "set"), ["set", "-"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
