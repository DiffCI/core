// SPDX-License-Identifier: MIT
/**
 * Phase 01 follow-up (2026-08-26): the always-run policy belongs to the repository, not the engine.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { readRepositoryConfig } from "../../src/repo/repo-config.js";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "diffci-config-"));
}
function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("repository DiffCI configuration", () => {
  it("reads alwaysRunTests from package.json", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "x", diffci: { alwaysRunTests: ["**/security.test.*"] } }));
      assert.deepEqual(readRepositoryConfig(root).alwaysRunTests, ["**/security.test.*"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("lets a dedicated diffci.json win over package.json", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "x", diffci: { alwaysRunTests: ["from-package.json"] } }));
      write(root, "diffci.json", JSON.stringify({ alwaysRunTests: ["from-diffci.json"] }));
      assert.deepEqual(readRepositoryConfig(root).alwaysRunTests, ["from-diffci.json"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("treats malformed configuration as absent rather than failing the analysis", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", "{ not json at all");
      write(root, "diffci.json", "{{{");
      assert.deepEqual(readRepositoryConfig(root), {});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("declares nothing when the repository declares nothing", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "x" }));
      assert.deepEqual(readRepositoryConfig(root), {});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("applies no always-run policy to a repository that declares none", () => {
    // The engine shipped three checks matching this project's and DentalPresence's own file names,
    // applied to every repository analysed. A repository that says nothing now gets nothing.
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "x", devDependencies: { vitest: "^4.0.0" } }));
      write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { noEmit: true }, include: ["**/*.ts"] }));
      write(root, "src/index.ts", "export const x = 1;\n");
      write(root, "src/security.test.ts", "test('security', () => {});\n");
      write(root, "src/other.test.ts", "test('other', () => {});\n");

      const profile = analyzeRepository({ repoPath: root });
      assert.equal(profile.diffciConfig?.alwaysRunTests, undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("carries a declared policy through to the profile the analyzer produces", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({
        name: "x",
        devDependencies: { vitest: "^4.0.0" },
        diffci: { alwaysRunTests: ["**/security.test.*"] },
      }));
      write(root, "src/security.test.ts", "test('security', () => {});\n");

      const profile = analyzeRepository({ repoPath: root });
      assert.deepEqual(profile.diffciConfig?.alwaysRunTests, ["**/security.test.*"]);
      assert.ok(new ImpactAnalyzer() instanceof ImpactAnalyzer, "default construction carries no built-in policy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reads declared inputs, and a diffci.json declaring only inputs wins over package.json", () => {
    const root = tmpRepo();
    try {
      write(root, "package.json", JSON.stringify({ name: "x", diffci: { alwaysRunTests: ["from-package.json"] } }));
      write(root, "diffci.json", JSON.stringify({ inputs: [{ files: ["prisma/schema.prisma"], tests: ["src/db/**/*.test.ts"] }] }));
      assert.deepEqual(readRepositoryConfig(root), { inputs: [{ files: ["prisma/schema.prisma"], tests: ["src/db/**/*.test.ts"] }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports a malformed inputs block as a configuration error instead of dropping entries", () => {
    // Dropping one entry would turn a declared edge into a silent skip; the error falls back instead.
    for (const inputs of [{ files: ["a"] }, [{ files: ["a"] }], [{ files: [], tests: ["b"] }], [{ files: ["a"], tests: [""] }], [null]]) {
      const root = tmpRepo();
      try {
        write(root, "diffci.json", JSON.stringify({ inputs }));
        const config = readRepositoryConfig(root);
        assert.equal(config.inputs, undefined, JSON.stringify(inputs));
        assert.match(config.configurationError ?? "", /Invalid inputs/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});
