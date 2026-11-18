// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { extractTestPatterns } from "../../src/repo/runner-universe.js";

// Jest replaces a leading <rootDir> in testPathIgnorePatterns. DiffCI compiled the token literally,
// so the pattern never matched, ignored files stayed in the universe and could be selected alone,
// giving `jest e2e/flow.test.js`, which exits 1 with "No tests found".
function universe(ignores: string[]): string[] {
  const root = mkdtempSync(join(tmpdir(), "diffci-jest-rootdir-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", scripts: { test: "jest" }, devDependencies: { jest: "^29.0.0" } }),
    "jest.config.js": `module.exports = { testMatch: ['**/*.test.js'], testPathIgnorePatterns: ${JSON.stringify(ignores)} };\n`,
    "src/a.test.js": `test("a", () => {});\n`,
    "e2e/flow.test.js": `test("flow", () => {});\n`,
    "packages/p/e2e/nested.test.js": `test("nested", () => {});\n`,
  };
  try {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
    return [...(analyzeRepository({ repoPath: root }).testFilePaths ?? [])].sort();
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a leading <rootDir> in testPathIgnorePatterns is the repository root", () => {
  assert.deepEqual(universe(["<rootDir>/e2e/"]), ["packages/p/e2e/nested.test.js", "src/a.test.js"]);
  assert.deepEqual(universe(["<rootDir>/node_modules/", "<rootDir>/e2e"]), ["packages/p/e2e/nested.test.js", "src/a.test.js"]);
});

test("an unanchored ignore still matches at any depth", () => {
  assert.deepEqual(universe(["/e2e/"]), ["src/a.test.js"]);
});

test("<rootDir> elsewhere in the pattern stays literal, as in jest", () => {
  assert.deepEqual(extractTestPatterns(`module.exports = { testPathIgnorePatterns: ['<rootDir>/e2e/', 'x<rootDir>'] }`).ignoreRegexSources, ["^/e2e/", "x<rootDir>"]);
  assert.deepEqual(universe(["e2e/<rootDir>"]), ["e2e/flow.test.js", "packages/p/e2e/nested.test.js", "src/a.test.js"]);
});
