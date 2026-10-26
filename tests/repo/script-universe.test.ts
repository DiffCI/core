// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { modelTestScriptUniverse, type ScriptUniverseInput } from "../../src/repo/script-universe.js";

const discovered = [
  "ops/cloudflare/src/routing.test.mjs",
  "scripts/d1-migration.test.mjs",
  "scripts/deploy.test.mjs",
  "scripts/report.test.ts",
  "src/lib/a.test.ts",
  "src/lib/deep/b.test.ts",
];

function model(scripts: Record<string, string>, files: Record<string, string> = {}, deps: Record<string, string[]> = {}): ReturnType<typeof modelTestScriptUniverse> {
  const input: ScriptUniverseInput = {
    scripts,
    discoveredTests: discovered,
    dependenciesOf: (path) => deps[path] ?? [],
    read: (path) => files[path],
    exists: (path) => discovered.includes(path) || path in files || discovered.some((test) => test.startsWith(`${path}/`)),
  };
  return modelTestScriptUniverse(input);
}

describe("modelTestScriptUniverse", () => {
  it("models DentalPresence's shape: listed files, quoted globs and assertion scripts", () => {
    const result = model({
      test: `node --test ops/cloudflare/src/routing.test.mjs scripts/deploy.test.mjs && tsx --conditions react-server --test "src/**/*.test.ts" "scripts/*.test.ts" && node scripts/test-security.js`,
      "test:d1-migration": "node --test scripts/d1-migration.test.mjs",
    }, { "scripts/test-security.js": `const fs = require("node:fs");\nimport(pathToFileURL(path.join(root, "next.config.mjs")).href);\n` });
    assert.equal(result.complete, true);
    assert.deepEqual(result.tests, ["ops/cloudflare/src/routing.test.mjs", "scripts/deploy.test.mjs", "scripts/report.test.ts", "src/lib/a.test.ts", "src/lib/deep/b.test.ts"]);
  });

  it("follows npm run phases and lifecycle hooks", () => {
    const result = model({ pretest: "node --test scripts/deploy.test.mjs", test: "npm run test:unit", "test:unit": "node --test src/lib" });
    assert.equal(result.complete, true);
    assert.deepEqual(result.tests, ["scripts/deploy.test.mjs", "src/lib/a.test.ts", "src/lib/deep/b.test.ts"]);
  });

  it("treats node --test without paths as every discovered test", () => {
    assert.deepEqual(model({ test: "tsc && node --test" }).tests, discovered);
  });

  it("includes tests an opaque phase imports or hands to an executing call", () => {
    const imported = model({ test: "node --test src/lib/a.test.ts && node scripts/run.mjs" }, { "scripts/run.mjs": `import "./deploy.test.mjs";` }, { "scripts/run.mjs": ["scripts/deploy.test.mjs"] });
    assert.ok(imported.tests.includes("scripts/deploy.test.mjs"));
    const spawned = model({ test: "node --test src/lib/a.test.ts && node scripts/run.mjs" }, { "scripts/run.mjs": `spawnSync(process.execPath, [join("scripts", "d1-migration.test.mjs")]);` });
    assert.ok(spawned.tests.includes("scripts/d1-migration.test.mjs"));
  });

  it("abandons the model rather than guess", () => {
    for (const test of [
      "vitest run",
      "node --test src || true",
      "node --test src | tee log",
      "make test",
      "npm run missing",
      "node --test src && node scripts/run.mjs",
    ]) {
      const result = model({ test }, { "scripts/run.mjs": `spawnSync("node", ["--test"])` });
      assert.equal(result.complete, false, test);
      assert.deepEqual(result.tests, discovered, test);
    }
    assert.equal(model({}).complete, false);
  });

  it("abandons the model when the script runs a test file discovery does not recognise", () => {
    const result = model({ test: "node --test checks/contract.mjs" }, { "checks/contract.mjs": "" });
    assert.equal(result.complete, false);
    assert.match(result.reason ?? "", /does not recognise/);
  });
});
