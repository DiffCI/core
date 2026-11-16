// SPDX-License-Identifier: MIT
/** The repository inventory lists every lockfile from the shared list as a config file (issue #97). */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { LOCKFILE_NAMES } from "../../src/repo/lockfiles.js";

describe("analyzeRepository config files", () => {
  for (const name of LOCKFILE_NAMES) {
    it(`lists ${name}, at the root and in a workspace package`, () => {
      const dir = mkdtempSync(join(tmpdir(), "diffci-analyzer-lockfiles-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
        mkdirSync(join(dir, "packages/web"), { recursive: true });
        writeFileSync(join(dir, name), "");
        writeFileSync(join(dir, "packages/web", name), "");

        const profile = analyzeRepository({ repoPath: dir });

        assert.ok(profile.configFiles.includes(name), `${name} missing from ${JSON.stringify(profile.configFiles)}`);
        assert.ok(profile.configFiles.includes(`packages/web/${name}`));
        assert.equal(profile.stats.configFiles, profile.configFiles.length);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("does not list a lockfile lookalike", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-analyzer-lockfiles-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
      writeFileSync(join(dir, "package-lock.json.bak"), "");
      const profile = analyzeRepository({ repoPath: dir });
      assert.deepEqual(profile.configFiles, ["package.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
