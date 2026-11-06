import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ignoredWatchPath, startWatch } from "../../src/client/watch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "client", "cli.ts");

function fakeWatcher() {
  let listener: ((path: string) => void) | undefined;
  return {
    watch: (_repo: string, onChange: (path: string) => void) => { listener = onChange; return { close() { listener = undefined; } }; },
    emit: (path: string) => listener?.(path),
  };
}

test("ignores .git and node_modules", () => {
  assert.ok(ignoredWatchPath(".git/index"));
  assert.ok(ignoredWatchPath("packages\\a\\node_modules\\x.js"));
  assert.ok(!ignoredWatchPath("src/a.ts"));
});

test("runs at start, debounces a burst of saves into one run, and ignores .git", async () => {
  const fake = fakeWatcher();
  let tree = "t0";
  let runs = 0;
  const session = startWatch({ repoPath: ".", debounceMs: 20, watch: fake.watch, currentTree: () => tree, run: async () => { runs += 1; return { treeSha: tree }; } });
  try {
    await session.idle();
    assert.equal(runs, 1, "the initial run");
    tree = "t1";
    fake.emit("src/a.ts");
    fake.emit("src/a.ts");
    fake.emit("src/b.ts");
    await session.idle();
    assert.equal(runs, 2, "one run for the burst");
    fake.emit(".git/index");
    await session.idle();
    assert.equal(runs, 2, ".git changes start nothing");
  } finally {
    session.stop();
  }
});

test("a save during a run queues exactly one more run, and the run's own writes start nothing", async () => {
  const fake = fakeWatcher();
  let tree = "t0";
  let runs = 0;
  let release: (() => void) | undefined;
  const session = startWatch({
    repoPath: ".", debounceMs: 10, watch: fake.watch, currentTree: () => tree,
    run: async () => {
      runs += 1;
      if (runs === 2) await new Promise<void>((resolve) => { release = resolve; });
      // The run writes a file: the tree it leaves is what the next comparison sees.
      tree = `${tree}+written`;
      return { treeSha: tree };
    },
  });
  try {
    await session.idle();
    tree = "t1";
    fake.emit("src/a.ts");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runs, 2, "the second run is in progress");
    tree = "t2";
    fake.emit("src/a.ts");
    fake.emit("src/b.ts");
    await new Promise((resolve) => setTimeout(resolve, 40));
    release!();
    await session.idle();
    assert.equal(runs, 3, "one queued run for every save made during the run");
    fake.emit("generated/out.json");
    await session.idle();
    assert.equal(runs, 3, "an event for a file the last run wrote starts nothing");
  } finally {
    session.stop();
  }
});

test("diffci watch verifies each save of a real repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-watch-cli-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "test@diffci.local");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowJs: true }, include: ["src", "test"] }));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src/a.js"), "export const a = () => 1;\n");
  writeFileSync(join(dir, "test/a.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { a } from '../src/a.js'; test('a', () => assert.equal(a(), 1));\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "initial");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT" && name !== "CI" && !name.startsWith("GITHUB_")));
  const child = spawn(process.execPath, ["--import", "tsx", CLI, "watch", "--repo", dir, "--no-log", "--debounce-ms", "200"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const waitFor = async (pattern: RegExp) => {
    for (let wait = 0; wait < 600 && !pattern.test(output); wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(output, pattern);
  };
  try {
    await waitFor(/no uncommitted changes/);
    writeFileSync(join(dir, "src/a.js"), "export const a = () => 1; // edited\n");
    await waitFor(/passed {2}selected 1 of 1 test files/);
    writeFileSync(join(dir, "src/a.js"), "export const a = () => 2;\n");
    await waitFor(/FAILED[\s\S]*failing tests: a/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watches a real directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-watch-"));
  let runs = 0;
  let tree = 0;
  const session = startWatch({ repoPath: dir, debounceMs: 50, currentTree: () => String(tree), run: async () => { runs += 1; return { treeSha: String(tree) }; } });
  try {
    await session.idle();
    tree += 1;
    writeFileSync(join(dir, "a.txt"), "x");
    for (let wait = 0; wait < 50 && runs < 2; wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(runs >= 2, "a save starts a run");
  } finally {
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
