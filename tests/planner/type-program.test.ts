// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { narrowGateChecks, type ChangedPath } from "../../src/planner/check-narrowing.js";
import { discoverGateChecks } from "../../src/planner/pipeline-steps.js";
import { programMembership, tscProject } from "../../src/planner/type-program.js";

const SOURCES: Record<string, string> = {
  "tsconfig.json": "{ \"compilerOptions\": { \"allowJs\": true }, \"include\": [\"src\"] }",
  "tsconfig.scripts.json": "{ \"extends\": \"./tsconfig.json\", \"include\": [\"scripts/**/*.ts\"] }",
  "src/a.ts": "import { b } from \"./b\";\nimport data from \"../data/routes.json\";\nimport helper from \"../tools/helper.mjs\";",
  "src/b.ts": "export const b = 1;",
  "scripts/build.ts": "console.log(1);",
};
const FILES = [...Object.keys(SOURCES), "docs/guide.md", "data/routes.json", "data/other.json", "tools/helper.mjs", "tools/unused.mjs", "ops/schema.sql", "types/global.d.ts", "package.json"];

const input = (changed: Array<string | ChangedPath>, extra: Record<string, string> = {}) => ({
  scripts: {},
  changes: changed.map((c) => (typeof c === "string" ? { path: c, status: "modified" as const } : c)),
  read: (path: string) => ({ ...SOURCES, ...extra })[path],
  files: FILES,
});

describe("programMembership", () => {
  it("counts roots, added roots and deleted roots", () => {
    assert.equal(programMembership("tsconfig.json", input(["src/b.ts"])).inProgram, true);
    assert.equal(programMembership("tsconfig.json", input([{ path: "src/new.ts", status: "added" }])).inProgram, true);
    assert.equal(programMembership("tsconfig.json", input([{ path: "src/gone.ts", status: "deleted" }])).inProgram, true);
  });

  it("counts files a root imports, and nothing else outside the roots", () => {
    assert.match(programMembership("tsconfig.json", input(["data/routes.json"])).reason, /imported by src\/a\.ts/);
    assert.equal(programMembership("tsconfig.json", input(["tools/helper.mjs"])).inProgram, true);
    const outside = programMembership("tsconfig.json", input(["docs/guide.md", "ops/schema.sql", "data/other.json", "tools/unused.mjs", "scripts/build.ts"]));
    assert.deepEqual(outside, { inProgram: false, reason: "no changed file is in the tsconfig.json program" });
    assert.equal(programMembership("tsconfig.scripts.json", input(["scripts/build.ts"])).inProgram, true);
  });

  it("treats configuration, dependencies and declarations as changing every file", () => {
    for (const path of ["tsconfig.json", "packages/x/tsconfig.base.json", "package.json", "yarn.lock", "types/global.d.ts"]) {
      assert.equal(programMembership("tsconfig.json", input([path])).inProgram, true, path);
    }
  });

  it("fails closed on unreadable configs and package bases", () => {
    assert.equal(programMembership("missing.json", input(["docs/guide.md"])).inProgram, true);
    const packageBase = { "tsconfig.json": "{ \"extends\": \"@tsconfig/node22/tsconfig.json\", \"include\": [\"src\"] }" };
    assert.equal(programMembership("tsconfig.json", input(["tools/unused.mjs"], packageBase)).inProgram, true);
    assert.equal(programMembership("tsconfig.json", input(["docs/guide.md"], packageBase)).inProgram, false);
  });
});

describe("tscProject", () => {
  it("reads plain project checks only", () => {
    assert.equal(tscProject("tsc --noEmit --pretty false"), "tsconfig.json");
    assert.equal(tscProject("npx tsc -p tsconfig.scripts.json --noEmit"), "tsconfig.scripts.json");
    assert.equal(tscProject("tsc --project packages/a"), "packages/a/tsconfig.json");
    assert.equal(tscProject("tsc --pretty --noEmit"), "tsconfig.json");
    for (const command of ["tsc -b", "tsc src/a.ts", "tsc --watch", "vue-tsc --noEmit"]) assert.equal(tscProject(command), undefined, command);
  });
});

describe("whole-program checks in the gate", () => {
  const scripts = { check: "npm run typecheck && npm run lint", typecheck: "tsc --noEmit", lint: "eslint \"src/**/*.ts\"" };
  const typeAware = { "eslint.config.mjs": "export default [{ languageOptions: { parserOptions: { projectService: true } } }];" };
  const plan = (changed: string[], extra: Record<string, string> = typeAware) =>
    narrowGateChecks(discoverGateChecks(scripts).checks, { ...input(changed, extra), scripts }).map((c) => [c.id, c.decision]);

  it("skips tsc and type-aware lint for changes outside the program", () => {
    assert.deepEqual(plan(["docs/guide.md", "tools/unused.mjs"]), [["typecheck", "SKIP"], ["lint", "SKIP"]]);
    assert.deepEqual(plan(["src/b.ts"]), [["typecheck", "RUN"], ["lint", "RUN"]]);
    assert.deepEqual(plan(["data/routes.json"]), [["typecheck", "RUN"], ["lint", "RUN"]]);
  });

  it("keeps import-plugin lint on the code-file rule", () => {
    const imports = { "eslint.config.mjs": "export default [{ parserOptions: { projectService: true }, rules: { \"import/no-cycle\": 2 } }];" };
    assert.deepEqual(plan(["tools/unused.mjs"], imports), [["typecheck", "SKIP"], ["lint", "RUN"]]);
  });
});
