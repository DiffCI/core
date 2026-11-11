// SPDX-License-Identifier: MIT
/**
 * `lockfileFacts` reports every committed lockfile name (issue #96). `bun.lock`, Bun's default text
 * lockfile since 1.2, was missing, so a Bun repository with only `bun.lock` produced no fact.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { lockfileFacts } from "../../src/ci-inference/evidence.js";
import { LOCKFILE } from "../../src/repo/lockfiles.js";

const NAMES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

for (const name of NAMES) {
  test(`lockfileFacts reports ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-lockfile-"));
    try {
      writeFileSync(join(dir, name), "");
      assert.deepEqual(lockfileFacts(dir), [{ kind: "lockfile.present", value: name, evidence: { file: name, text: name } }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("lockfileFacts knows every name the shared LOCKFILE pattern matches", () => {
  for (const name of NAMES) assert.match(name, LOCKFILE);
});

test("lockfileFacts reports nothing without a lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-lockfile-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    assert.deepEqual(lockfileFacts(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
