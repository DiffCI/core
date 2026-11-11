// SPDX-License-Identifier: MIT
/**
 * A change to any committed lockfile changes the Vue analysis cache context (issue #97).
 * `npm-shrinkwrap.json` was missing from the hand-written list, so editing it reused a stale analysis.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { economicsContext } from "../../src/cache/economics-context.js";
import { LOCKFILE_NAMES } from "../../src/repo/lockfiles.js";

for (const name of LOCKFILE_NAMES) {
  test(`changing ${name} changes the economics context`, () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-economics-"));
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      const absent = economicsContext(dir);
      writeFileSync(join(dir, name), "one");
      const one = economicsContext(dir);
      writeFileSync(join(dir, name), "two");
      const two = economicsContext(dir);
      assert.notEqual(one, absent);
      assert.notEqual(two, one);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
