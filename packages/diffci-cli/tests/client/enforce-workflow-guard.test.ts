/**
 * Enforce mode audit (docs/enforce-mode-01-plan.md, step 4): `diffci verify-workflow --enforce`.
 *
 * Each case is one way an enforce installation can end up skipping pull request tests with nothing
 * checking the skips: the gate is a dry run, the kill switch is hardcoded, or the full suite on main was
 * guarded away along with the pull request one.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { auditEnforceWorkflows, evaluatePushCondition, isNonInterfering } from "../../src/client/workflow-guard.js";

/** `testScript: null` writes a package.json with no test script. */
function repoWith(workflows: Record<string, string>, testScript: string | null = "tsx --test"): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-enforce-guard-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const [name, contents] of Object.entries(workflows)) writeFileSync(join(dir, ".github", "workflows", name), contents);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: testScript === null ? {} : { test: testScript } }));
  return dir;
}

function audit(workflows: Record<string, string>, testScript?: string | null) {
  const dir = repoWith(workflows, testScript);
  try {
    const result = auditEnforceWorkflows(dir);
    return { ...result, codes: result.findings.map((finding) => finding.code).sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CI = (testIf = "${{ github.event_name != 'pull_request' || vars.DIFFCI_ENFORCE != 'on' }}", on = "push:\n    branches: [main]\n  pull_request:") => `
on:
  ${on}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - name: Test
        if: ${testIf}
        run: npm run test
`;

const ENFORCE = (env = "${{ vars.DIFFCI_ENFORCE }}", extra = "") => `
on: pull_request
jobs:
  enforce:
    if: \${{ vars.DIFFCI_ENFORCE == 'on' }}
    runs-on: ubuntu-latest${extra}
    steps:
      - run: npm ci
      - env:
          DIFFCI_ENFORCE: ${env}
        run: node --import tsx src/client/cli.ts verify --policy enforce --json --out "$RUNNER_TEMP/r.json"
`;

describe("enforce workflow audit", () => {
  it("accepts a gated enforce job with the full suite still on push to main", () => {
    const result = audit({ "ci.yml": CI(), "diffci-enforce.yml": ENFORCE() });
    assert.deepEqual(result.codes, []);
    assert.equal(result.fullCommand, "npm test");
    assert.deepEqual(result.enforceJobs, [`${join(".github", "workflows", "diffci-enforce.yml")}#enforce`]);
    assert.deepEqual(result.fullSuiteJobs, [`${join(".github", "workflows", "ci.yml")}#check`]);
    assert.ok(isNonInterfering(result));
  });

  it("does not count a continue-on-error job as the gate", () => {
    const result = audit({ "ci.yml": CI(), "dry-run.yml": ENFORCE(undefined, "\n    continue-on-error: true") });
    assert.deepEqual(result.codes, ["ENFORCE_JOB_MISSING"]);
  });

  for (const [label, env] of [["hardcoded on", '"on"'], ["a different variable", "${{ vars.SOMETHING_ELSE }}"]] as const) {
    it(`blocks a kill switch that is ${label}`, () => {
      assert.deepEqual(audit({ "ci.yml": CI(), "diffci-enforce.yml": ENFORCE(env) }).codes, ["ENFORCE_KILL_SWITCH_NOT_WIRED"]);
    });
  }

  it("blocks when the full suite was guarded off push as well as pull_request", () => {
    const result = audit({ "ci.yml": CI("${{ vars.DIFFCI_ENFORCE != 'on' }}"), "diffci-enforce.yml": ENFORCE() });
    assert.deepEqual(result.codes, ["FULL_SUITE_NOT_ON_DEFAULT_BRANCH"]);
    assert.match(result.findings[0]!.message, /could not be shown to hold/);
  });

  it("blocks when the full suite workflow does not run on push to main", () => {
    assert.deepEqual(audit({ "ci.yml": CI(undefined, "pull_request:"), "diffci-enforce.yml": ENFORCE() }).codes, ["FULL_SUITE_NOT_ON_DEFAULT_BRANCH"]);
    assert.deepEqual(audit({ "ci.yml": CI(undefined, "push:\n    branches: [release/*]"), "diffci-enforce.yml": ENFORCE() }).codes, ["FULL_SUITE_NOT_ON_DEFAULT_BRANCH"]);
  });

  it("does not count a push trigger with a paths filter", () => {
    const result = audit({ "ci.yml": CI(undefined, "push:\n    branches: [main]\n    paths: [src/**]"), "diffci-enforce.yml": ENFORCE() });
    assert.deepEqual(result.codes, ["FULL_SUITE_NOT_ON_DEFAULT_BRANCH"]);
  });

  it("does not count a narrowed test command as the full suite", () => {
    const ci = CI().replace("run: npm run test", "run: npm test -- tests/one.test.ts");
    assert.deepEqual(audit({ "ci.yml": ci, "diffci-enforce.yml": ENFORCE() }).codes, ["FULL_SUITE_NOT_ON_DEFAULT_BRANCH"]);
  });

  it("blocks when no full command can be inferred", () => {
    assert.deepEqual(audit({ "ci.yml": CI(), "diffci-enforce.yml": ENFORCE() }, null).codes, ["FULL_COMMAND_UNKNOWN"]);
  });

});

describe("push condition evaluation", () => {
  const cases: Array<[string, string]> = [
    ["${{ github.event_name != 'pull_request' || vars.DIFFCI_ENFORCE != 'on' }}", "TRUE"],
    ["${{ vars.DIFFCI_ENFORCE != 'on' }}", "UNKNOWN"],
    ["github.event_name == 'pull_request'", "FALSE"],
    ["github.ref == 'refs/heads/main' && always()", "TRUE"],
    ["github.event_name == 'push' && vars.X == 'y'", "UNKNOWN"],
    ["!(github.event_name == 'pull_request')", "TRUE"],
    ["GITHUB.EVENT_NAME == 'PUSH'", "UNKNOWN"],
    ["github.event_name == 'PUSH'", "TRUE"],
    ["contains(github.ref, 'main')", "UNKNOWN"],
    ["failure()", "FALSE"],
  ];
  for (const [expression, expected] of cases) {
    it(`${expression} -> ${expected}`, () => assert.equal(evaluatePushCondition(expression, "main"), expected));
  }
});
