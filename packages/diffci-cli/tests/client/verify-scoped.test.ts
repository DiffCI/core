import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { agentScopedSelection, selectionInstruction } from "../../src/client/agent-selection.js";
import { installPrePushHook } from "../../src/client/hook.js";
import { dependencyDirectories } from "../../src/client/isolated-worktree.js";

/**
 * Two agent sessions in one checkout (2026-11-17, DentalPresence): session A stages its own files and
 * verifies them; session B has uncommitted work with a failing test. A's `--staged` and `--paths`
 * verification must see only HEAD plus A's files, list B's as excluded, and still catch A's own break.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

/** Each test file appends its name to $DIFFCI_TEST_MARKER when it runs, so a test can count executions. */
function testFile(name: string, importLine: string, assertion: string): string {
  return `import test from 'node:test'; import assert from 'node:assert/strict'; import { appendFileSync } from 'node:fs'; ${importLine}
if (process.env.DIFFCI_TEST_MARKER) appendFileSync(process.env.DIFFCI_TEST_MARKER, '${name}\\n');
test('${name}', () => { ${assertion} });
`;
}

function fixture(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "diffci-verify-scoped-"));
  const dir = join(root, "work");
  mkdirSync(dir);
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "test@diffci.local");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  write(dir, ".gitignore", "node_modules\n");
  write(dir, "package.json", JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }));
  write(dir, "src/alpha.js", "export const alpha = () => 1;\n");
  write(dir, "src/beta.js", "export const beta = () => 2;\n");
  write(dir, "test/alpha.test.js", testFile("alpha", "import { alpha } from '../src/alpha.js';", "assert.equal(alpha(), 1);"));
  write(dir, "test/beta.test.js", testFile("beta", "import { beta } from '../src/beta.js';", "assert.equal(beta(), 2);"));
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial");
  return { root, dir };
}

/** Session B: an unstaged change to beta that its test catches, and an untracked work-in-progress file. */
function sessionB(dir: string): void {
  write(dir, "src/beta.js", "export const beta = () => 20;\n");
  write(dir, "src/wip.js", "export const wip = true;\n");
}

/** Session A: a correct change to alpha and its test. */
function sessionA(dir: string, value = 3, testValue = value): void {
  write(dir, "src/alpha.js", `export const alpha = () => ${value};\n`);
  write(dir, "test/alpha.test.js", testFile("alpha", "import { alpha } from '../src/alpha.js';", `assert.equal(alpha(), ${testValue});`));
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && !name.startsWith("GITHUB_"))),
    DO_NOT_TRACK: "1",
    ...extra,
  };
}

function verify(dir: string, args: string[], extra: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, ["--import", "tsx", CLI, "verify", "--repo", dir, "--json", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 600_000, env: env(extra), windowsHide: true,
  });
  let report: any;
  try { report = JSON.parse(run.stdout); } catch { report = undefined; }
  return { ...run, report };
}

function worktreeCount(dir: string): number {
  return git(dir, "worktree", "list").split("\n").length;
}

describe("verify --staged and --paths in a checkout shared by two sessions", () => {
  it("verifies only A's staged files, lists B's as excluded, and leaves the checkout as it was", () => {
    const { root, dir } = fixture();
    try {
      sessionB(dir);
      sessionA(dir);
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      const statusBefore = git(dir, "status", "--porcelain");

      // The problem: --changed verifies B's work too, fails on it, and points to --staged.
      const changed = verify(dir, ["--changed"]);
      assert.equal(changed.status, 1, changed.stdout + changed.stderr);
      assert.match(changed.stderr, /verify --staged/);

      const staged = verify(dir, ["--staged"]);
      assert.equal(staged.status, 0, staged.stdout + staged.stderr);
      const report = staged.report;
      assert.equal(report.scope, "staged");
      assert.equal(report.verification, "passed");
      assert.equal(report.safe_to_continue, true);
      assert.equal(report.selection, "selected");
      assert.deepEqual(report.selected_tests, ["test/alpha.test.js"]);
      assert.equal(report.scoped.isolation, "temporary-worktree");
      assert.deepEqual(report.scoped.verified_files.sort(), ["src/alpha.js", "test/alpha.test.js"]);
      assert.equal(report.scoped.excluded_dirty_files, 2);
      assert.deepEqual(report.scoped.excluded_dirty_paths.sort(), ["src/beta.js", "src/wip.js"]);
      assert.equal(report.snapshot.base_sha, git(dir, "rev-parse", "HEAD"));
      assert.equal(report.snapshot.before_tree_sha, git(dir, "write-tree"), "the receipt's tree is the tree a commit of the index has");

      assert.equal(git(dir, "status", "--porcelain"), statusBefore, "the checkout and index are untouched");
      assert.equal(readFileSync(join(dir, "src/beta.js"), "utf8"), "export const beta = () => 20;\n");
      assert.equal(worktreeCount(dir), 1, "the temporary worktree is removed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies only the given paths without staging them", () => {
    const { root, dir } = fixture();
    try {
      sessionB(dir);
      sessionA(dir);
      const run = verify(dir, ["--paths", "src/alpha.js", "test/alpha.test.js"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(run.report.scope, "paths");
      assert.deepEqual(run.report.selected_tests, ["test/alpha.test.js"]);
      assert.deepEqual(run.report.scoped.excluded_dirty_paths.sort(), ["src/beta.js", "src/wip.js"]);
      assert.equal(git(dir, "diff", "--cached", "--name-only"), "", "nothing was staged");

      const listFile = join(root, "paths.txt");
      writeFileSync(listFile, "src/alpha.js\r\ntest/alpha.test.js\r\n");
      const fromFile = verify(dir, ["--paths-from", listFile]);
      assert.equal(fromFile.status, 0, fromFile.stdout + fromFile.stderr);
      assert.deepEqual(fromFile.report.scoped.verified_files.sort(), ["src/alpha.js", "test/alpha.test.js"]);
      assert.equal(worktreeCount(dir), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still catches A's own break, and B's dirty files cannot rescue it", () => {
    const { root, dir } = fixture();
    try {
      sessionB(dir);
      sessionA(dir, 3, 4);
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      const broken = verify(dir, ["--staged"]);
      assert.equal(broken.status, 1, broken.stdout + broken.stderr);
      assert.equal(broken.report.verification, "failed");
      assert.equal(broken.report.safe_to_continue, false);
      assert.equal(worktreeCount(dir), 1, "removed after a failure too");

      // A's staged file uses a function only B's uncommitted beta.js defines: in isolation it fails.
      write(dir, "src/beta.js", "export const beta = () => 2;\nexport const gamma = () => 5;\n");
      write(dir, "src/alpha.js", "import { gamma } from './beta.js';\nexport const alpha = () => gamma();\n");
      write(dir, "test/alpha.test.js", testFile("alpha", "import { alpha } from '../src/alpha.js';", "assert.equal(alpha(), 5);"));
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      assert.equal(verify(dir, ["--changed"]).status, 0, "with B's file the change passes");
      const rescued = verify(dir, ["--paths", "src/alpha.js", "test/alpha.test.js"]);
      assert.equal(rescued.status, 1, rescued.stdout + rescued.stderr);
      assert.deepEqual(rescued.report.scoped.head_version_imports, [{ file: "src/alpha.js", imports: ["src/beta.js"] }]);
      assert.match(rescued.report.reason, /verified at their HEAD version/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies against the HEAD version of an excluded file a scoped file imports, and says so", () => {
    const { root, dir } = fixture();
    try {
      sessionB(dir);
      write(dir, "src/alpha.js", "import { beta } from './beta.js';\nexport const alpha = () => beta() + 1;\n");
      write(dir, "test/alpha.test.js", testFile("alpha", "import { alpha } from '../src/alpha.js';", "assert.equal(alpha(), 3);"));
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      const run = verify(dir, ["--staged"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.deepEqual(run.report.scoped.head_version_imports, [{ file: "src/alpha.js", imports: ["src/beta.js"] }]);

      const redacted = verify(dir, ["--staged", "--redact-paths", "--no-reuse"]);
      assert.equal(redacted.status, 0, redacted.stdout + redacted.stderr);
      for (const path of [...redacted.report.scoped.verified_files, ...redacted.report.scoped.excluded_dirty_paths]) assert.match(path, /^[0-9a-f]{12}$/);
      assert.doesNotMatch(JSON.stringify(redacted.report.scoped), /beta|wip|alpha/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes with nothing run when nothing is staged, and rejects conflicting modes", () => {
    const { root, dir } = fixture();
    try {
      sessionB(dir);
      const run = verify(dir, ["--staged"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(run.report.selection, "none");
      assert.equal(run.report.scoped.excluded_dirty_files, 2);
      assert.equal(verify(dir, ["--staged", "--changed"]).status, 2);
      assert.equal(verify(dir, ["--paths"]).status, 2);
      assert.equal(verify(dir, ["--paths", "../outside.js"]).status, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to reuse installed dependencies when the verified lockfile differs from the checkout's", () => {
    const { root, dir } = fixture();
    try {
      write(dir, "package-lock.json", "{\"lockfileVersion\":3}\n");
      git(dir, "add", "package-lock.json");
      git(dir, "commit", "--quiet", "-m", "lockfile");
      sessionA(dir);
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      write(dir, "package-lock.json", "{\"lockfileVersion\":3,\"packages\":{}}\n");
      const run = verify(dir, ["--staged"]);
      assert.equal(run.status, 2, run.stdout + run.stderr);
      assert.match(run.report.reason, /package-lock\.json/);
      assert.equal(worktreeCount(dir), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("links node_modules into the temporary worktree and removes only the link", () => {
    const { root, dir } = fixture();
    try {
      write(dir, "node_modules/marker/KEEP", "keep\n");
      write(dir, "node_modules/marker/index.js", "export const marker = 7;\n");
      assert.deepEqual(dependencyDirectories(dir), ["node_modules"]);
      write(dir, "src/alpha.js", "import { marker } from 'marker';\nexport const alpha = () => marker;\n");
      write(dir, "test/alpha.test.js", testFile("alpha", "import { alpha } from '../src/alpha.js';", "assert.equal(alpha(), 7);"));
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      const run = verify(dir, ["--staged"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.ok(existsSync(join(dir, "node_modules/marker/KEEP")), "the real dependencies are kept");
      assert.equal(worktreeCount(dir), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the pre-push hook reuse a staged pass after commit, without running the tests again", () => {
    const { root, dir } = fixture();
    try {
      const remote = join(root, "remote.git");
      git(root, "init", "-q", "--bare", remote);
      git(dir, "remote", "add", "origin", remote);
      git(dir, "push", "-q", "-u", "origin", "main");
      git(dir, "remote", "set-head", "origin", "main");
      const slash = (path: string) => path.replace(/\\/g, "/");
      installPrePushHook(dir, `"${slash(process.execPath)}" --import "${import.meta.resolve("tsx")}" "${slash(CLI)}"`, true);

      const marker = join(root, "ran.log");
      sessionB(dir);
      sessionA(dir);
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      const staged = verify(dir, ["--staged"], { DIFFCI_TEST_MARKER: marker });
      assert.equal(staged.status, 0, staged.stdout + staged.stderr);
      assert.equal(readFileSync(marker, "utf8"), "alpha\n");

      git(dir, "commit", "--quiet", "-m", "alpha");
      assert.equal(git(dir, "rev-parse", "HEAD^{tree}"), staged.report.snapshot.before_tree_sha);
      const push = spawnSync("git", ["push", "origin", "main"], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 600_000, env: env({ DIFFCI_TEST_MARKER: marker }) });
      assert.equal(push.status, 0, push.stdout + push.stderr);
      assert.match(push.stderr, /clean temporary worktree/);
      assert.match(push.stdout + push.stderr, /reused the passing selected run of this exact tree/);
      assert.equal(readFileSync(marker, "utf8"), "alpha\n", "the tests did not run again");
      assert.equal(worktreeCount(dir), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("diffci_select_tests with a scope", () => {
  it("plans HEAD plus the index only and returns one scoped verify command", async () => {
    const { root, dir } = fixture();
    try {
      sessionB(dir);
      sessionA(dir);
      git(dir, "add", "--", "src/alpha.js", "test/alpha.test.js");
      const plan = await agentScopedSelection(dir, { kind: "staged" });
      assert.equal(plan.status, "planned");
      assert.equal(plan.scope, "staged");
      assert.deepEqual(plan.selected_tests, ["test/alpha.test.js"]);
      assert.deepEqual([...plan.changed_files].sort(), ["src/alpha.js", "test/alpha.test.js"]);
      assert.equal(plan.excluded_dirty_files, 2);
      assert.match(plan.command ?? "", /verify --staged --json$/);
      assert.equal("commands" in plan ? plan.commands : undefined, undefined);
      const instruction = selectionInstruction(plan);
      assert.match(instruction, /Run exactly:\n.*verify --staged --json\n/);
      assert.match(instruction, /2 other changed file\(s\)/);

      const paths = await agentScopedSelection(dir, { kind: "paths", paths: ["src/alpha.js", "test/alpha.test.js"] });
      assert.match(paths.command ?? "", /verify --json --paths src\/alpha\.js test\/alpha\.test\.js$/);
      assert.equal(worktreeCount(dir), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
