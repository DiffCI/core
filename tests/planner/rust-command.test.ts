// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { planSelectiveTestCommands } from "../../src/planner/test-command.js";
import type { RepositoryProfile } from "../../src/repo/types.js";

function profile(): RepositoryProfile {
  return {
    adapters: [{ id: "rust", version: "1", blockers: [] }],
    rustTestInvocation: "cargo test",
    rustTestPackages: { "crates/core/src/lib.rs": "actual-core", "crates/core/tests/one.rs": "actual-core", "crates/core/tests/two.rs": "actual-core", "cli/src/main.rs": "cli" },
    rustTestTargets: { "crates/core/src/lib.rs": { name: "actual_core", kind: "lib" }, "crates/core/tests/one.rs": { name: "custom-integration", kind: "test" }, "crates/core/tests/two.rs": { name: "second", kind: "test" }, "cli/src/main.rs": { name: "cli", kind: "bin" } },
    packageManager: "unknown", packageJson: { scripts: {}, dependencies: [], devDependencies: [] },
    sourceRoots: [], tests: [], testFilePaths: ["crates/core/src/lib.rs", "crates/core/tests/one.rs", "crates/core/tests/two.rs", "cli/src/main.rs"],
    workflows: [], configFiles: ["Cargo.toml"], pathAliases: [], entryPoints: [],
    stats: { sourceFiles: 4, testFiles: 4, workflowFiles: 0, configFiles: 1 },
  };
}

function refuses(p: RepositoryProfile, paths = ["crates/core/src/lib.rs"]): void {
  const plan = planSelectiveTestCommands(p, paths);
  assert.ok(plan.refusalReason);
  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.unroutedPaths, paths);
}

describe("Rust selective command synthesis", () => {
  it("uses Cargo package names, retains crate unit tests and doctests, and sorts packages", () => {
    const plan = planSelectiveTestCommands(profile(), ["cli/src/main.rs", "crates/core/src/lib.rs", "crates/core/tests/one.rs"]);
    assert.equal(plan.refusalReason, undefined);
    assert.deepEqual(plan.commands, [
      { executable: "cargo", args: ["test", "-p", "actual-core", "-p", "cli"] },
    ]);
    assert.deepEqual(plan.groups.flatMap(group => group.paths).sort(), ["cli/src/main.rs", "crates/core/src/lib.rs", "crates/core/tests/one.rs"]);
  });

  it("selects custom integration target names instead of deriving names from paths", () => {
    const plan = planSelectiveTestCommands(profile(), ["crates/core/tests/one.rs"]);
    assert.deepEqual(plan.commands, [{ executable: "cargo", args: ["test", "-p", "actual-core", "--test", "custom-integration"] }]);
  });

  it("deduplicates and sorts multiple integration selections", () => {
    const plan = planSelectiveTestCommands(profile(), ["crates/core/tests/two.rs", "crates/core/tests/one.rs", "crates/core/tests/one.rs"]);
    assert.deepEqual(plan.commands[0]?.args, ["test", "-p", "actual-core", "--test", "custom-integration", "--test", "second"]);
    assert.equal(plan.groups[0]?.paths.length, 2);
  });

  it("explicitly invokes selected bench and example targets", () => {
    const p = profile();
    p.testFilePaths.push("benches/speed.rs", "examples/demo.rs");
    p.rustTestPackages!["benches/speed.rs"] = "actual-core";
    p.rustTestPackages!["examples/demo.rs"] = "actual-core";
    p.rustTestTargets!["benches/speed.rs"] = { name: "speed", kind: "bench" };
    p.rustTestTargets!["examples/demo.rs"] = { name: "demo", kind: "example" };
    const plan = planSelectiveTestCommands(p, ["crates/core/src/lib.rs", "benches/speed.rs", "examples/demo.rs"]);
    assert.deepEqual(plan.commands.map(command => command.args), [
      ["test", "-p", "actual-core"], ["test", "-p", "actual-core", "--bench", "speed"], ["test", "-p", "actual-core", "--example", "demo"],
    ]);
  });

  it("refuses missing invocation evidence, including cached profiles", () => {
    const p = profile(); delete p.rustTestInvocation; refuses(p);
  });
  it("refuses profiles without the Rust adapter", () => {
    const p = profile(); delete p.adapters; refuses(p);
  });
  it("refuses missing package, target or discovered test identity", () => {
    for (const missing of ["package", "target", "identity"]) {
      const p = profile();
      if (missing === "package") delete p.rustTestPackages;
      if (missing === "target") delete p.rustTestTargets;
      if (missing === "identity") p.testFilePaths = [];
      refuses(p);
    }
  });
  it("never interprets unclaimed Rust files as JavaScript tests", () => {
    refuses(profile(), ["unknown.rs"]);
  });
  it("refuses mixed-language selections atomically", () => {
    refuses(profile(), ["crates/core/src/lib.rs", "unit.test.ts"]);
  });
  it("honors Rust adapter blockers even when aggregate blockers are empty", () => {
    const p = profile(); p.adapterBlockers = []; p.adapters![0]!.blockers.push("Unsupported Cargo features"); refuses(p);
  });
  it("refuses package specs, wildcard targets and option injection", () => {
    for (const name of ["--workspace", "*", "crate@1.0", "a/b", "a\nb", "a b"]) {
      const p = profile(); p.rustTestPackages!["crates/core/src/lib.rs"] = name; refuses(p);
      const q = profile(); q.rustTestTargets!["crates/core/src/lib.rs"]!.name = name; refuses(q);
    }
  });
  for (const command of ["cargo nextest run", "cargo make test", "just test", "./scripts/test.sh", "cargo test --features foo", "cargo test --all-features", "cargo test --no-default-features", "cargo test && ./verify.sh"]) {
    it(`refuses unsupported invocation: ${command}`, () => {
      const p = profile(); p.packageJson.scripts.test = command; refuses(p);
    });
  }
  it("refuses lifecycle phases instead of silently dropping them", () => {
    const p = profile(); p.packageJson.scripts.pretest = "./prepare.sh"; refuses(p);
  });
  it("accepts a verified plain Cargo script and produces nothing for an empty selection", () => {
    const p = profile(); p.packageJson.scripts.test = "cargo test";
    assert.equal(planSelectiveTestCommands(p, ["crates/core/src/lib.rs"]).refusalReason, undefined);
    assert.deepEqual(planSelectiveTestCommands(p, []).commands, []);
  });
});
