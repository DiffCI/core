// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { matchesAny } from "../../../src/research/baseline/matcher.js";

// Regression coverage for a bug found while fixing discoverTests() during the Stage 0
// pilot follow-up (2026-08-19): regexFrom()'s "**/" -> "(?:.*/)?" substitution was
// corrupted by the subsequent global "*" -> "[^/]*" replace re-matching the "*" it had
// just inserted, so patterns using a leading or embedded "**/" only reliably matched
// paths zero or one directory level deep - the exact shape PATH-baseline glob rules use.
describe("matchesAny", () => {
  it("matches files nested two or more directories deep under a globstar pattern", () => {
    const pattern = ["src/**/*.test.ts"];
    assert.ok(matchesAny("src/a.test.ts", pattern));
    assert.ok(matchesAny("src/lib/a.test.ts", pattern));
    assert.ok(matchesAny("src/lib/security/a.test.ts", pattern), "two directory levels deep should still match");
  });

  it("matches a leading globstar pattern regardless of nesting depth", () => {
    const pattern = ["**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"];
    assert.ok(matchesAny("request.test.ts", pattern));
    assert.ok(matchesAny("src/request.test.ts", pattern));
    assert.ok(matchesAny("src/middleware/csrf/index.test.ts", pattern), "two directory levels deep should still match");
  });

  it("does not match unrelated paths", () => {
    const pattern = ["src/**/*.test.ts"];
    assert.ok(!matchesAny("src/lib/security/scanner.ts", pattern));
    assert.ok(!matchesAny("docs/readme.md", pattern));
  });
});
