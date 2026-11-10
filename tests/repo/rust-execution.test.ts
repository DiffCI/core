// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import type { CommandSpec, ExecutionPlan } from "../../src/planner/types.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

// Ordinary Node-only development may skip this executable fixture. Rust validation must set
// DIFFCI_REQUIRE_CARGO=1 so a missing/broken toolchain cannot produce a successful skipped run.
const toolchain = ["cargo", "rustc", "rustdoc"].map(executable => ({
  executable,
  result: spawnSync(executable, ["--version"], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
  }),
}));
const cargoAvailable = toolchain.every(({ result }) => result.status === 0);

const changedPath = "leaf/src/value.rs";
const affectedTests = ["consumer/src/lib.rs", "consumer/tests/api.rs", "leaf/src/lib.rs", "leaf/tests/api.rs"];
const unrelatedTests = ["unrelated/src/lib.rs", "unrelated/tests/api.rs"];
const healthySource = `pub fn unit_value(input: i32) -> i32 { input * 2 }
pub fn integration_value(input: i32) -> i32 { input + 1 }
pub fn documentation_value(input: i32) -> i32 { input - 1 }
`;

function manifest(name: string): string {
  // Package and integration-target names deliberately differ from their directory/file names.
  return `[package]
name = "execution-${name}"
version = "0.1.0"
edition = "2021"
autotests = false

[[test]]
name = "${name}-contract"
path = "tests/api.rs"
`;
}

function fixtureFiles(): Record<string, string> {
  return {
    ".gitignore": "/target/\n",
    "Cargo.toml": '[workspace]\nmembers = ["leaf", "consumer", "unrelated"]\nresolver = "2"\n',
    ".github/workflows/test.yml": "name: test\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: cargo test\n",
    "leaf/Cargo.toml": manifest("leaf"),
    [changedPath]: healthySource,
    "leaf/src/lib.rs": `mod value;
pub use value::{unit_value, integration_value};

/// Subtracts one from the input.
/// \`\`\`
/// assert_eq!(execution_leaf::leaf_doc_value(43), 42);
/// \`\`\`
pub fn leaf_doc_value(input: i32) -> i32 { value::documentation_value(input) }

#[cfg(test)]
mod tests {
    #[test]
    fn leaf_unit_contract() { assert_eq!(super::unit_value(21), 42); }
}
`,
    "leaf/tests/api.rs": "#[test]\nfn leaf_integration_contract() { assert_eq!(execution_leaf::integration_value(41), 42); }\n",
    "consumer/Cargo.toml": `${manifest("consumer")}\n[dependencies]\nexecution-leaf = { path = "../leaf" }\n`,
    "consumer/src/lib.rs": `pub fn observed_unit_value(input: i32) -> i32 { execution_leaf::unit_value(input) }
pub fn observed_integration_value(input: i32) -> i32 { execution_leaf::integration_value(input) }

/// Preserves the leaf's documented result.
/// \`\`\`
/// assert_eq!(execution_consumer::consumer_doc_value(43), 42);
/// \`\`\`
pub fn consumer_doc_value(input: i32) -> i32 { execution_leaf::leaf_doc_value(input) }

#[cfg(test)]
mod tests {
    #[test]
    fn consumer_unit_contract() { assert_eq!(super::observed_unit_value(21), 42); }
}
`,
    "consumer/tests/api.rs": "#[test]\nfn consumer_integration_contract() { assert_eq!(execution_consumer::observed_integration_value(41), 42); }\n",
    "unrelated/Cargo.toml": manifest("unrelated"),
    "unrelated/src/lib.rs": `pub fn unrelated_value() -> i32 { 7 }

/// Returns an independent value.
/// \`\`\`
/// assert_eq!(execution_unrelated::unrelated_doc_value(), 7);
/// \`\`\`
pub fn unrelated_doc_value() -> i32 { unrelated_value() }

#[cfg(test)]
mod tests {
    #[test]
    fn unrelated_unit_contract() { assert_eq!(super::unrelated_value(), 7); }
}
`,
    "unrelated/tests/api.rs": "#[test]\nfn unrelated_integration_contract() { assert_eq!(execution_unrelated::unrelated_value(), 7); }\n",
  };
}

function run(root: string, command: CommandSpec) {
  // Execute the generated argv verbatim, with no shell or manually selected Cargo targets.
  // Keep build outputs in this owned fixture and preserve the caller's TMPDIR for compiler temps.
  const result = spawnSync(command.executable, command.args, {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CARGO_NET_OFFLINE: "true", CARGO_TERM_COLOR: "never", RUSTUP_AUTO_INSTALL: "0", CARGO_TARGET_DIR: join(root, "target"), ...command.env },
  });
  return { command, ...result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

type RunResult = ReturnType<typeof run>;

function assertSuccess(result: RunResult): void {
  assert.equal(result.error, undefined, result.output);
  assert.equal(result.signal, null, result.output);
  assert.equal(result.status, 0, `${JSON.stringify(result.command)}\n${result.output}`);
}

function report(t: TestContext, scenario: string, mode: "selected" | "full", results: RunResult[]): void {
  // These are observed executions/counts, not timing measurements or avoided-compute estimates.
  t.diagnostic(JSON.stringify({
    scenario, mode, runs: results.map(result => ({
      command: [result.command.executable, ...result.command.args], exitCode: result.status,
      testResults: [...result.output.matchAll(/^test .+ \.\.\. (?:ok|FAILED).*$/gm)].map(match => match[0]),
      summaries: [...result.output.matchAll(/^test result:.*$/gm)].map(match => match[0]),
    })),
  }));
}

function assertHealthy(results: RunResult[], crates: string[]): void {
  for (const result of results) assertSuccess(result);
  const output = results.map(result => result.output).join("\n");
  for (const name of crates) {
    assert.match(output, new RegExp(`test tests::${name}_unit_contract \\.\\.\\. ok`));
    assert.match(output, new RegExp(`test ${name}_integration_contract \\.\\.\\. ok`));
    assert.match(output, new RegExp(` - ${name}_doc_value \\(line \\d+\\) \\.\\.\\. ok`));
  }
  const summaries = [...output.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)];
  assert.equal(summaries.length, crates.length * 3, output);
  assert.equal(summaries.reduce((total, match) => total + Number(match[1]), 0), crates.length * 3, output);
  assert.ok(summaries.every(match => match[2] === "0" && match[3] === "0"), output);
}

function assertRuntimeFailure(results: RunResult[], expectedFailure: RegExp): void {
  assert.ok(results.length > 0);
  for (const result of results) {
    assert.equal(result.error, undefined, result.output);
    assert.equal(result.signal, null, result.output);
    assert.equal(result.status, 101, `${JSON.stringify(result.command)}\n${result.output}`);
    assert.match(result.output, expectedFailure);
    assert.match(result.output, /test result: FAILED\./);
    assert.doesNotMatch(result.output, /could not compile|error\[E\d+\]/);
  }
}

test("real Cargo selection executes affected suites and detects source regressions", {
  skip: !cargoAvailable && process.env.DIFFCI_REQUIRE_CARGO !== "1" ? "Cargo/Rust toolchain unavailable; set DIFFCI_REQUIRE_CARGO=1 to require execution" : false,
  timeout: 300_000,
}, async t => {
  // Inherited Git redirection could put fixture commits or indexes outside its owned root.
  // Reject it before the first Git invocation; analyzeGitDelta inherits the same environment.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    assert.ok(!process.env[key], `${key} must be unset for the isolated Cargo execution fixture`);
  }
  for (const { executable, result } of toolchain) {
    assert.equal(result.status, 0, `${executable} is required for Rust execution validation: ${result.error?.message ?? result.stderr}`);
  }
  const root = mkdtempSync(join(tmpdir(), "diffci-rust-execution-"));
  const files = fixtureFiles();
  try {
    function git(...args: string[]): string {
      // Commit only inside the owned fixture, with a fixed test identity, no signing or hooks,
      // and no user/global configuration writes. Cargo commands keep their original argv.
      const result = run(root, {
        executable: "git", args: ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, ".git", "no-hooks")}`, "-c", "core.autocrlf=false", ...args],
        env: {
          GIT_AUTHOR_NAME: "DiffCI fixture", GIT_AUTHOR_EMAIL: "fixture@diffci.invalid",
          GIT_COMMITTER_NAME: "DiffCI fixture", GIT_COMMITTER_EMAIL: "fixture@diffci.invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      });
      assertSuccess(result);
      return result.stdout.trim();
    }
    function commitSource(source: string, message: string): string {
      writeFileSync(join(root, changedPath), source);
      git("add", "--", changedPath);
      git("commit", "--quiet", "-m", message);
      return git("rev-parse", "HEAD");
    }
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    // Dependency-free, workspace-local packages need no downloads. Preparation is explicit;
    // buildDependencyGraph subsequently invokes the real offline/locked Cargo metadata adapter.
    assertSuccess(run(root, { executable: "cargo", args: ["generate-lockfile", "--offline"] }));
    const lockfile = readFileSync(join(root, "Cargo.lock"), "utf8");
    const inventory = new Set([...Object.keys(files), "Cargo.lock"]);
    git("init", "--quiet");
    // The first head is a real, behavior-preserving production refactor, not an invented delta.
    writeFileSync(join(root, changedPath), healthySource.replace("input * 2", "input + input"));
    git("add", "--", ...inventory);
    git("commit", "--quiet", "-m", "Create Cargo execution fixture");
    const baselineSha = git("rev-parse", "HEAD");
    const healthySha = commitSource(healthySource, "Refactor leaf arithmetic");
    const snapshot = () => [...inventory].map(path => [path, readFileSync(join(root, path), "utf8")]);
    async function planChange(baseSha: string): Promise<ExecutionPlan> {
      const headSha = git("rev-parse", "HEAD");
      assert.equal(git("status", "--porcelain"), "", "execution must match the committed head");
      const before = snapshot();
      const deltaResult = await analyzeGitDelta({ repoPath: root, baseSha, headSha });
      assert.ok(deltaResult.success, JSON.stringify(deltaResult));
      assert.deepEqual(deltaResult.delta.files.map(({ path, changeType }) => ({ path, changeType })), [{ path: changedPath, changeType: "modified" }]);
      assert.equal(deltaResult.delta.analysis.empty, false);
      assert.ok(deltaResult.inventory);
      assert.deepEqual([...deltaResult.inventory.files].sort(), [...inventory].sort());
      const graph = await buildDependencyGraph({ repoPath: root });
      assert.deepEqual(graph.adapterBlockers, []);
      assert.equal(graph.confidence, "COMPLETE");
      assert.equal(graph.profile.rustTestInvocation, "cargo test");
      assert.deepEqual([...graph.profile.testFilePaths].sort(), [...affectedTests, ...unrelatedTests].sort());
      assert.equal(graph.profile.rustTestPackages?.["leaf/src/lib.rs"], "execution-leaf");
      assert.deepEqual(graph.profile.rustTestTargets?.["consumer/tests/api.rs"], { name: "consumer-contract", kind: "test" });
      const change = deltaResult.delta;
      const impact = new ImpactAnalyzer().analyze(change, graph, graph.profile, {
        repositoryFiles: deltaResult.inventory.files, readRepositoryFile: repositoryFileReader(root),
      });
      assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
      assert.deepEqual(impact.affectedTests.map(entry => entry.path).sort(), affectedTests);
      const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta: change, impact, profile: graph.profile });
      assert.equal(plan.mode, "SELECTIVE");
      assert.equal(plan.commandSynthesis?.status, "OK", plan.commandSynthesis?.reason);
      assert.deepEqual([...plan.selectedTests].sort(), affectedTests);
      assert.deepEqual([...plan.skippedTests].sort(), unrelatedTests);
      assert.deepEqual(plan.commandSpecs, [{ executable: "cargo", args: ["test", "-p", "execution-consumer", "-p", "execution-leaf"] }]);
      assert.deepEqual(snapshot(), before, "metadata, graph construction and planning must not modify fixture inputs");
      assert.equal(git("rev-parse", "HEAD"), headSha);
      assert.equal(git("status", "--porcelain"), "");
      t.diagnostic(JSON.stringify({ baseSha, headSha, changes: deltaResult.delta.files, selectedTests: plan.selectedTests, skippedTests: plan.skippedTests }));
      return plan;
    }
    function executeSelected(plan: ExecutionPlan): RunResult[] {
      assert.equal(plan.commandSynthesis?.status, "OK");
      assert.ok(plan.commandSpecs.length > 0, "an empty command list is not a successful selected run");
      return plan.commandSpecs.map(command => run(root, command));
    }
    // The independent full baseline uses the exact original workflow invocation, not a command
    // reconstructed from selected tests. Environment-only offline mode applies equally to both.
    const executeFull = () => [run(root, { executable: "cargo", args: ["test"] })];

    await t.test("healthy selected and full runs include unit tests, named integrations and doctests", async t => {
      const plan = await planChange(baselineSha);
      const full = executeFull();
      const selected = executeSelected(plan);
      report(t, "healthy", "full", full);
      report(t, "healthy", "selected", selected);
      assertHealthy(full, ["leaf", "consumer", "unrelated"]);
      assertHealthy(selected, ["leaf", "consumer"]);
      assert.doesNotMatch(selected.map(result => result.output).join("\n"), /unrelated_(?:unit_contract|integration_contract|doc_value)/);
    });

    const mutations = [
      { name: "unit-test source regression", before: "input * 2", after: "input * 3", failure: /test tests::(?:leaf|consumer)_unit_contract \.\.\. FAILED/ },
      { name: "integration-only source regression", before: "input + 1", after: "input + 2", failure: /test (?:leaf|consumer)_integration_contract \.\.\. FAILED/ },
      { name: "doctest-only source regression", before: "input - 1", after: "input - 2", failure: /test .+ - (?:leaf|consumer)_doc_value \(line \d+\) \.\.\. FAILED/ },
    ];
    for (const mutation of mutations) {
      await t.test(`selected and full commands both catch a ${mutation.name}`, async t => {
        // Change production arithmetic only. The contracts, manifests and planner are unchanged.
        const mutatedSource = healthySource.replace(mutation.before, mutation.after);
        assert.notEqual(mutatedSource, healthySource);
        commitSource(mutatedSource, mutation.name);
        try {
          const plan = await planChange(healthySha);
          const selected = executeSelected(plan);
          const full = executeFull();
          report(t, mutation.name, "selected", selected);
          report(t, mutation.name, "full", full);
          assertRuntimeFailure(selected, mutation.failure);
          assertRuntimeFailure(full, mutation.failure);
        } finally { writeFileSync(join(root, changedPath), healthySource); }
      });
    }

    await t.test("restoring production code restores both selected and full success", async t => {
      commitSource(healthySource, "Restore healthy arithmetic");
      const plan = await planChange(baselineSha);
      const selected = executeSelected(plan);
      const full = executeFull();
      report(t, "restored", "selected", selected);
      report(t, "restored", "full", full);
      assertHealthy(selected, ["leaf", "consumer"]);
      assertHealthy(full, ["leaf", "consumer", "unrelated"]);
      assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), lockfile);
      for (const [path, source] of Object.entries(files)) assert.equal(readFileSync(join(root, path), "utf8"), source, path);
      assert.equal(git("status", "--porcelain"), "");
    });
  } finally {
    // Only this test's mkdtemp-owned directory is removed, never an inherited TMPDIR or cache.
    rmSync(root, { recursive: true, force: true });
  }
});
