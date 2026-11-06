import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildCoverageMap, coverageAdditions, readCoverageMap, type CoverageMap } from "../../src/client/coverage-map.js";

function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

test("maps each node:test file to the modules it loads, the files it reads and the directories it lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-coverage-map-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    write(dir, "package.json", JSON.stringify({ type: "module" }));
    write(dir, "src/price.js", "export const price = (n) => n * 2;\n");
    write(dir, "fixtures/users.json", "[1, 2, 3]\n");
    write(dir, "locales/en.json", "{}\n");
    write(dir, "test/price.test.js", "import test from 'node:test'; import assert from 'node:assert/strict'; import { price } from '../src/price.js'; test('price', () => assert.equal(price(2), 4));\n");
    write(dir, "test/users.test.js", [
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync, readdirSync } from 'node:fs';",
      "test('users', () => { assert.equal(JSON.parse(readFileSync(new URL('../fixtures/users.json', import.meta.url), 'utf8')).length, 3); assert.equal(readdirSync(new URL('../locales', import.meta.url)).length, 1); });",
    ].join("\n"));
    const run = buildCoverageMap(dir, "node --test test/price.test.js test/users.test.js", { timeoutMs: 120_000, nodeOptions: "" });
    assert.equal(run.error, undefined, run.execution.stderrTail);
    assert.equal(run.execution.exitCode, 0, run.execution.stderrTail);
    assert.ok(run.map!.tests["test/price.test.js"]!.includes("src/price.js"), "an ESM import, through V8 coverage");
    assert.ok(run.map!.tests["test/users.test.js"]!.includes("fixtures/users.json"), "a fixture read by name");
    assert.ok(run.map!.tests["test/users.test.js"]!.includes("locales/"), "a listed directory");
    assert.ok(!run.map!.tests["test/users.test.js"]!.includes("src/price.js"));
    assert.deepEqual(readCoverageMap(dir)?.tests, run.map!.tests, "kept inside .git");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports when no node:test process ran under the probe", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-coverage-none-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    const run = buildCoverageMap(dir, "node -e \"process.exit(0)\"", { timeoutMs: 60_000, nodeOptions: "" });
    assert.match(run.error ?? "", /needs node:test/);
    assert.equal(readCoverageMap(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adds the tests a changed file reaches through the map, and nothing already selected", () => {
  const map: CoverageMap = { schema: "diffci.coverage-map.v1", produced_at: "", command: "npm test", tests: {
    "test/a.test.js": ["src/a.js"], "test/users.test.js": ["fixtures/users.json"], "test/locales.test.js": ["locales/"],
  } };
  assert.deepEqual(coverageAdditions(map, ["fixtures/users.json", "locales/fr.json", "src/a.js"], ["test/a.test.js"]), [
    { test: "test/users.test.js", changed_file: "fixtures/users.json" },
    { test: "test/locales.test.js", changed_file: "locales/fr.json" },
  ]);
});
