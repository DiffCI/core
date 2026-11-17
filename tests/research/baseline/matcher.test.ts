// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fc from "fast-check";
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

  // #178: every character that is not glob syntax is literal, and no pattern throws.
  it("treats regex metacharacters in a pattern as literal characters", () => {
    assert.ok(matchesAny("app/(shop)/page.tsx", ["app/(shop)/**"]));
    assert.ok(!matchesAny("app/shop/page.tsx", ["app/(shop)/**"]));
    assert.ok(matchesAny("c++/x.cc", ["c++/*"]));
    assert.ok(matchesAny("a|b/$x^.ts", ["a|b/$x^.ts"]));
    assert.ok(!matchesAny("ab/x.ts", ["a|b/*"]));
  });

  it("matches ? as exactly one character within a segment", () => {
    assert.ok(matchesAny("src/a.ts", ["src/?.ts"]));
    assert.ok(!matchesAny("src/ab.ts", ["src/?.ts"]));
    assert.ok(!matchesAny("src/a/b.ts", ["src/a?b.ts"]));
  });

  it("supports character classes and a backslash escape", () => {
    assert.ok(matchesAny("src/v2.ts", ["src/v[0-9].ts"]));
    assert.ok(!matchesAny("src/vx.ts", ["src/v[0-9].ts"]));
    assert.ok(matchesAny("src/vx.ts", ["src/v[!0-9].ts"]));
    assert.ok(matchesAny("app/[id]/page.tsx", ["app/\\[id\\]/*"]));
    assert.ok(!matchesAny("app/i/page.tsx", ["app/\\[id\\]/*"]));
    assert.ok(matchesAny("a/[b", ["a/[b"]), "an unclosed [ is literal");
  });

  it("lets a ** that is not next to a slash cross directories", () => {
    assert.ok(matchesAny("a/b/c.js", ["**"]));
    assert.ok(matchesAny("a/b/c.js", ["**.js"]));
    assert.ok(!matchesAny("a/b/c.ts", ["**.js"]));
    assert.ok(matchesAny("src", ["src/**"]));
    assert.ok(matchesAny("src/a/b", ["src/**"]));
    assert.ok(matchesAny("a/x/y/b", ["a/**/b"]));
    assert.ok(matchesAny("a/b", ["a/**/b"]));
  });

  it("never throws, whatever the pattern", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (path, pattern) => {
      matchesAny(path, [pattern]);
    }), { numRuns: 2000 });
  });
});
