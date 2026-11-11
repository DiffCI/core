// SPDX-License-Identifier: MIT
/** `LOCKFILE_NAMES` and the `LOCKFILE` pattern describe the same files (issue #97). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCKFILE, LOCKFILE_NAMES } from "../../src/repo/lockfiles.js";

test("every LOCKFILE_NAMES entry matches LOCKFILE", () => {
  for (const name of LOCKFILE_NAMES) assert.match(name, LOCKFILE);
});

test("LOCKFILE matches only the names LOCKFILE_NAMES lists", () => {
  // The pattern's alternatives, spelled out: a name the pattern accepts must be in the list.
  for (const name of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    assert.ok(LOCKFILE_NAMES.includes(name), name);
  }
  for (const name of ["package.json", "bun.lockbb", "yarn.lock.bak", "pnpm-lock.yml"]) assert.doesNotMatch(name, LOCKFILE);
});
