// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { narrowGateChecks, type ChangedPath, type NarrowingInput } from "../../src/planner/check-narrowing.js";
import { discoverGateChecks } from "../../src/planner/pipeline-steps.js";

const PER_FILE_CONFIG = "export default [{ files: ['src/**/*.ts'], rules: { 'no-var': 'error' } }];";

function plan(scripts: Record<string, string>, changes: Array<string | ChangedPath>, files: Record<string, string> = { "eslint.config.mjs": PER_FILE_CONFIG }, extra: Partial<NarrowingInput> = {}) {
  const { checks } = discoverGateChecks(scripts);
  return narrowGateChecks(checks, {
    scripts,
    changes: changes.map((c) => (typeof c === "string" ? { path: c, status: "modified" as const } : c)),
    read: (path) => files[path],
    ...extra,
  });
}

const decisions = (checks: ReturnType<typeof plan>) => checks.map((c) => [c.id, c.decision, c.command]);

describe("narrowGateChecks", () => {
  it("lints only the changed files a per-file ESLint glob covers", () => {
    const checks = plan({ check: "npm run lint", lint: "eslint --cache \"src/**/*.{ts,tsx}\"" }, ["src/a.ts", "docs/x.md", "src/b.css"]);
    assert.deepEqual(decisions(checks), [["lint", "NARROWED", "eslint --cache src/a.ts"]]);
    assert.equal(checks[0]!.runsScript, false);
  });

  it("skips a per-file check that covers no changed file, and narrows prettier", () => {
    assert.deepEqual(decisions(plan({ lint: "eslint src" }, ["docs/x.md", "scripts/a.js"])), [["lint", "SKIP", "eslint src"]]);
    assert.deepEqual(decisions(plan({ "format:check": "prettier --check ." }, ["docs/x.md", "src/a.ts", "img.png"], {})), [["format:check", "NARROWED", "prettier --check docs/x.md src/a.ts"]]);
  });

  it("runs the whole check when its configuration, a file it names, package.json or a lockfile changed", () => {
    const scripts = { lint: "eslint src" };
    const config = { "eslint.config.mjs": "import rules from './eslint-rules/index.js';\nexport default [rules];" };
    for (const changed of ["eslint.config.mjs", "eslint-rules/no-x.js", "package.json", "pnpm-lock.yaml", "src/.eslintrc.json"]) {
      assert.equal(plan(scripts, ["src/a.ts", changed], config)[0]!.decision, "RUN", changed);
    }
  });

  it("treats type-aware and import-plugin configs as whole-program", () => {
    const typeAware = { "eslint.config.mjs": "export default [{ languageOptions: { parserOptions: { projectService: true } } }];" };
    assert.deepEqual(decisions(plan({ lint: "eslint \"src/**/*.ts\"" }, ["src/a.ts"], typeAware)), [["lint", "RUN", "eslint \"src/**/*.ts\""]]);
    assert.equal(plan({ lint: "eslint src" }, ["docs/a.md"], typeAware)[0]!.decision, "SKIP");
    const imports = { ".eslintrc.json": "{ \"rules\": { \"import/no-cycle\": \"error\" } }" };
    assert.equal(plan({ lint: "eslint src" }, ["src/a.ts"], imports)[0]!.decision, "RUN");
    const nested = plan({ lint: "eslint src" }, ["src/a.ts"], { "eslint.config.mjs": PER_FILE_CONFIG }, { files: ["eslint.config.mjs", "src/legacy/.eslintrc.json"] });
    assert.match(nested[0]!.reason, /nested ESLint config/);
  });

  it("keeps ESLint whole for deletions, --max-warnings, unknown flags and unsafe paths", () => {
    assert.equal(plan({ lint: "eslint src" }, [{ path: "src/b.ts", status: "deleted" }, "src/a.ts"])[0]!.decision, "RUN");
    assert.equal(plan({ lint: "eslint --max-warnings 0 src" }, ["src/a.ts"])[0]!.decision, "RUN");
    assert.equal(plan({ lint: "eslint --max-warnings 0 src" }, ["docs/a.md"])[0]!.decision, "SKIP");
    assert.equal(plan({ lint: "eslint --rule 'no-x: 2' src" }, ["src/a.ts"])[0]!.decision, "RUN");
    assert.equal(plan({ lint: "eslint src" }, ["src/a b.ts"])[0]!.decision, "RUN");
  });

  it("leaves scripts with hooks, other tools and other kinds unchanged", () => {
    const hooked = plan({ check: "npm run lint", lint: "eslint src", prelint: "node gen.js" }, ["src/a.ts"]);
    assert.deepEqual(hooked.map((c) => [c.id, c.decision]), [["lint", "RUN"]]);
    assert.deepEqual(plan({ check: "tsc && stylelint \"**/*.css\" && node scripts/arch.js" }, ["src/a.ts"]).map((c) => c.decision), ["RUN", "RUN", "RUN"]);
  });
});
