// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { narrowGateChecks } from "../../src/planner/check-narrowing.js";
import { discoverGateChecks } from "../../src/planner/pipeline-steps.js";

const ARCHITECTURE = [
  "const fs = require(\"fs\");",
  "const path = require(\"path\");",
  "const root = path.resolve(__dirname, \"..\");",
  "function sourceFiles(directory) {",
  "  return fs.readdirSync(directory).map((name) => path.join(directory, name));",
  "}",
  // A template with a substitution and a regex with quotes must not hide the literal that follows.
  "const message = (file) => `${file} couples \"x\"`;",
  "const pattern = /[\"'][^\"']+[\"']/;",
  "const files = sourceFiles(path.join(root, \"src\"));",
  "const pkg = JSON.parse(fs.readFileSync(path.join(root, \"package.json\"), \"utf8\"));",
].join("\n");

function decide(script: string, changed: string[], sources: Record<string, string>, extraFiles: string[] = []) {
  const scripts = { check: script };
  const files = [...Object.keys(sources), "src/lib/a.ts", "src/app/page.tsx", "docs/guide.md", "ops/infra.json", "package.json", ...extraFiles];
  const [check] = narrowGateChecks(discoverGateChecks(scripts).checks, {
    scripts,
    changes: changed.map((path) => ({ path, status: "modified" as const })),
    read: (path) => sources[path],
    files,
  });
  return check!;
}

describe("repository-script checks", () => {
  const sources = { "scripts/arch.js": ARCHITECTURE };

  it("runs when a change is under a directory the script names", () => {
    const check = decide("node scripts/arch.js", ["src/lib/a.ts"], sources);
    assert.equal(check.decision, "RUN");
    assert.match(check.reason, /reads src/);
  });

  it("skips when no changed file is anywhere the script reads", () => {
    const check = decide("node scripts/arch.js", ["docs/guide.md", "ops/infra.json"], sources);
    assert.equal(check.decision, "SKIP");
    assert.match(check.reason, /package\.json, scripts, src/);
  });

  it("runs when the script, a module it imports or package.json changed", () => {
    const withLib = { "scripts/check.mjs": "import { list } from \"./lib/files.mjs\";\nlist(\"ops\");", "scripts/lib/files.mjs": "export const list = (d) => d;" };
    assert.equal(decide("node scripts/check.mjs", ["scripts/lib/files.mjs"], withLib).decision, "RUN");
    assert.equal(decide("node scripts/check.mjs", ["ops/infra.json"], withLib).decision, "RUN");
    assert.equal(decide("node scripts/check.mjs", ["src/lib/a.ts"], withLib).decision, "SKIP");
    assert.equal(decide("node scripts/arch.js", ["package.json"], sources).decision, "RUN");
  });

  it("follows command-line arguments and file basenames", () => {
    const reader = { "scripts/read.mjs": "import { readFileSync } from \"node:fs\";\nreadFileSync(process.argv[2]);\nconst marker = \"page.tsx\";" };
    assert.equal(decide("node scripts/read.mjs ops/infra.json", ["ops/infra.json"], reader).decision, "RUN");
    assert.match(decide("node scripts/read.mjs ops/infra.json", ["src/app/page.tsx"], reader).reason, /names page\.tsx/);
    assert.equal(decide("node scripts/read.mjs ops/infra.json", ["src/lib/a.ts"], reader).decision, "SKIP");
  });

  it("runs for any change when its reads cannot be bounded", () => {
    const unbounded: Record<string, string> = {
      spawns: "import { spawnSync } from \"node:child_process\";\nspawnSync(\"php\", [\"-l\", \"x.php\"]);",
      walksRoot: "const root = process.cwd();\nfor (const f of listFiles(root)) check(f);",
      glob: "import { globSync } from \"node:fs\";\nglobSync(\"**/*.ts\");",
      env: "readFileSync(process.env.REPORT_PATH);",
      computed: "const name = \"./lib\";\nrequire(name);",
      alias: "import x from \"@/lib/a\";",
      missing: "import x from \"./nope.mjs\";",
    };
    for (const [name, text] of Object.entries(unbounded)) {
      const check = decide("node scripts/c.mjs", ["docs/guide.md"], { "scripts/c.mjs": text });
      assert.equal(check.decision, "RUN", name);
      assert.match(check.reason, /runs for any change/, name);
    }
  });

  it("leaves other commands, hooked scripts and missing inventories alone", () => {
    assert.equal(decide("bash scripts/c.sh", ["docs/guide.md"], {}).decision, "RUN");
    const scripts = { check: "npm run arch && tsc", arch: "node scripts/arch.js", prearch: "node gen.js" };
    const checks = narrowGateChecks(discoverGateChecks(scripts).checks, { scripts, changes: [{ path: "docs/guide.md", status: "modified" }], read: (path) => sources[path as keyof typeof sources], files: ["scripts/arch.js"] });
    assert.ok(checks.every((c) => c.decision === "RUN"));
    const noFiles = narrowGateChecks(discoverGateChecks({ check: "node scripts/arch.js" }).checks, { scripts: { check: "node scripts/arch.js" }, changes: [{ path: "docs/guide.md", status: "modified" }], read: (path) => sources[path as keyof typeof sources] });
    assert.equal(noFiles[0]!.decision, "RUN");
  });
});
