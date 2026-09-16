// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Phase 01 (2026-08-26): the command DiffCI proposes must be one the TARGET repository could run.
 *
 * The fixtures mirror real repositories from the Phase 01 baseline, where the previous module
 * proposed `tsx --conditions react-server --test <paths>` - this repository's runner, carrying
 * DentalPresence's Next.js condition - for vitest and mocha suites alike.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { commandSpecToString, planSelectiveTestCommands } from "../../src/planner/test-command.js";
import type { RepositoryProfile } from "../../src/repo/types.js";
import type { KnownTestFramework } from "../../src/repo/test-framework.js";
import type { TestRunnerConfig } from "../../src/repo/test-discovery.js";

function profileOf(options: {
  frameworks?: KnownTestFramework[];
  packageManager?: RepositoryProfile["packageManager"];
  configs?: TestRunnerConfig[];
}): RepositoryProfile {
  const frameworks = options.frameworks ?? [];
  return {
    packageManager: options.packageManager ?? "npm",
    packageJson: { name: "fixture", scripts: {}, dependencies: [], devDependencies: [] },
    sourceRoots: [],
    tests: [],
    testFilePaths: [],
    testRunnerConfigs: options.configs,
    testUniverse: {
      declaredFrameworks: frameworks,
      frameworkEvidence: Object.fromEntries(frameworks.map((f) => [f, "dependency:" + f])),
      discoveredTestFiles: 1,
      blindSpot: false,
    },
    workflows: [],
    configFiles: [],
    pathAliases: [],
    entryPoints: [],
    stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 },
  };
}

/** A config fixture with the runner-universe fields defaulted. These tests are about command
 * routing, not universe narrowing, so they take the conservative non-authoritative defaults. */
function configOf(c: Pick<TestRunnerConfig, "file" | "runner" | "includes" | "scripts"> & Partial<TestRunnerConfig>): TestRunnerConfig {
  return { excludeGlobs: [], ignoreRegexSources: [], roots: [], declaresTests: c.includes.length > 0, isDefault: false, authoritative: false, ...c };
}

describe("selective test command synthesis", () => {
  it("emits a vitest command for a vitest repository (unjs/h3's case)", () => {
    const plan = planSelectiveTestCommands(
      profileOf({ frameworks: ["vitest"], packageManager: "pnpm" }),
      ["test/security.test.ts"],
    );

    assert.equal(plan.refusalReason, undefined);
    assert.equal(commandSpecToString(plan.commands[0]!), "pnpm exec vitest run test/security.test.ts");
    assert.deepEqual(plan.unroutedPaths, []);
  });

  it("emits a mocha command for a mocha repository (typeorm/typeorm's case)", () => {
    const plan = planSelectiveTestCommands(
      profileOf({ frameworks: ["mocha"], packageManager: "pnpm" }),
      ["test/functional/query-builder.test.ts"],
    );
    assert.equal(commandSpecToString(plan.commands[0]!), "pnpm exec mocha test/functional/query-builder.test.ts");
  });

  it("invokes node --test directly rather than through a package manager", () => {
    const plan = planSelectiveTestCommands(
      profileOf({ frameworks: ["node:test"], packageManager: "npm" }),
      ["tests/repo/impact.test.ts"],
    );
    assert.equal(commandSpecToString(plan.commands[0]!), "node --test tests/repo/impact.test.ts");
  });

  it("uses each package manager's own way of reaching a local binary", () => {
    const forManager = (packageManager: RepositoryProfile["packageManager"]) =>
      commandSpecToString(
        planSelectiveTestCommands(profileOf({ frameworks: ["vitest"], packageManager }), ["a.test.ts"]).commands[0]!,
      );

    assert.equal(forManager("npm"), "npx --no-install vitest run a.test.ts");
    assert.equal(forManager("pnpm"), "pnpm exec vitest run a.test.ts");
    assert.equal(forManager("yarn"), "yarn run vitest run a.test.ts");
    assert.equal(forManager("bun"), "bunx vitest run a.test.ts");
    assert.equal(forManager("unknown"), "npx --no-install vitest run a.test.ts");
  });

  it("routes each test to the config that claims it, so families are not flattened together", () => {
    // A repository with separate unit and e2e configs runs them as separate jobs, often with
    // different credentials or browsers. Collapsing them into one invocation would be a different
    // job from the one the repository actually runs.
    const configs: TestRunnerConfig[] = [
      configOf({ file: "vitest.e2e.config.ts", runner: "vitest", includes: ["test/e2e/**/*.test.ts"], scripts: ["test:e2e"], family: "e2e" }),
      configOf({ file: "vitest.config.ts", runner: "vitest", includes: ["test/unit/**/*.test.ts"], scripts: ["test"] }),
    ];
    const plan = planSelectiveTestCommands(
      profileOf({ frameworks: ["vitest"], packageManager: "pnpm", configs }),
      ["test/e2e/login.test.ts", "test/unit/parse.test.ts"],
    );

    assert.equal(plan.groups.length, 2);
    const rendered = plan.commands.map(commandSpecToString).sort();
    assert.deepEqual(rendered, [
      "pnpm exec vitest run --config vitest.config.ts test/unit/parse.test.ts",
      "pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/login.test.ts",
    ]);
    assert.deepEqual(plan.unroutedPaths, []);
  });

  it("falls through to the primary framework's default configuration for unclaimed files", () => {
    const configs: TestRunnerConfig[] = [
      configOf({ file: "vitest.e2e.config.ts", runner: "vitest", includes: ["test/e2e/**/*.test.ts"], scripts: ["test:e2e"], family: "e2e" }),
    ];
    const plan = planSelectiveTestCommands(
      profileOf({ frameworks: ["vitest"], packageManager: "pnpm", configs }),
      ["src/lib/parse.test.ts"],
    );

    assert.equal(plan.groups.length, 1);
    assert.equal(commandSpecToString(plan.commands[0]!), "pnpm exec vitest run src/lib/parse.test.ts");
  });

  it("refuses, with a reason, rather than guessing a runner", () => {
    const plan = planSelectiveTestCommands(profileOf({ frameworks: [] }), ["test/thing.test.ts"]);

    assert.deepEqual(plan.commands, []);
    assert.ok(plan.refusalReason?.includes("no recognised test framework"));
    assert.deepEqual(plan.unroutedPaths, ["test/thing.test.ts"]);
  });

  it("emits nothing and refuses nothing for an empty selection", () => {
    const plan = planSelectiveTestCommands(profileOf({ frameworks: ["vitest"] }), []);
    assert.deepEqual(plan.commands, []);
    assert.equal(plan.refusalReason, undefined);
  });

  it("escapes paths that would otherwise be reinterpreted by a shell", () => {
    const plan = planSelectiveTestCommands(
      profileOf({ frameworks: ["vitest"], packageManager: "pnpm" }),
      ["test/weird name; rm -rf x.test.ts"],
    );
    const rendered = commandSpecToString(plan.commands[0]!);
    assert.ok(!/[^\\];/.test(rendered), `unescaped semicolon in: ${rendered}`);
    assert.ok(rendered.includes("\\;"));
  });
});

describe("frameworks added 2026-08-26", () => {
  function profile(frameworks: KnownTestFramework[], packageManager: RepositoryProfile["packageManager"] = "npm"): RepositoryProfile {
    return {
      packageManager,
      packageJson: { name: "fixture", scripts: {}, dependencies: [], devDependencies: [] },
      sourceRoots: [], tests: [], testFilePaths: [], workflows: [], configFiles: [], pathAliases: [], entryPoints: [],
      testUniverse: { declaredFrameworks: frameworks, frameworkEvidence: {}, discoveredTestFiles: 1, blindSpot: false },
      stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 },
    };
  }

  it("invokes each new runner the way that runner expects", () => {
    const render = (frameworks: KnownTestFramework[], paths: string[], pm: RepositoryProfile["packageManager"] = "npm") =>
      commandSpecToString(planSelectiveTestCommands(profile(frameworks, pm), paths).commands[0]!);

    assert.equal(render(["jasmine"], ["spec/a.spec.js"]), "npx --no-install jasmine spec/a.spec.js");
    assert.equal(render(["bun:test"], ["src/a.test.ts"], "bun"), "bun test src/a.test.ts");
    assert.equal(render(["playwright"], ["e2e/login.spec.ts"]), "npx --no-install playwright test e2e/login.spec.ts");
  });

  it("gives cypress a single comma-separated --spec, not positional paths", () => {
    // Cypress reads positional arguments as something else entirely, so passing paths that way would
    // produce a command that runs the wrong specs rather than one that fails loudly.
    const rendered = commandSpecToString(
      planSelectiveTestCommands(profile(["cypress"]), ["cypress/e2e/a.cy.ts", "cypress/e2e/b.cy.ts"]).commands[0]!,
    );
    assert.equal(rendered, "npx --no-install cypress run --spec cypress/e2e/a.cy.ts,cypress/e2e/b.cy.ts");
  });

  it("never routes an unclaimed unit test to an end-to-end runner", () => {
    // A repository with both declares two real frameworks. Routing src/lib.test.ts to playwright
    // would emit a command that runs nothing and reports success.
    const plan = planSelectiveTestCommands(profile(["vitest", "playwright"]), ["src/lib.test.ts"]);
    assert.equal(commandSpecToString(plan.commands[0]!), "npx --no-install vitest run src/lib.test.ts");
  });

  it("still uses an e2e runner when it is the only framework the repository declares", () => {
    const plan = planSelectiveTestCommands(profile(["playwright"]), ["e2e/a.spec.ts"]);
    assert.equal(commandSpecToString(plan.commands[0]!), "npx --no-install playwright test e2e/a.spec.ts");
  });
});
