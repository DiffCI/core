import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
// @ts-expect-error plain ESM script without type declarations
import { globToRegExp, involvedLogins, parseAreas, reviewersToRequest } from "../scripts/request-area-reviews.mjs";

const config = JSON.parse(readFileSync(new URL("../.github/area-maintainers.json", import.meta.url), "utf8"));
const areas = parseAreas({
  areas: [
    { area: "Yarn", maintainers: ["KingEmma7"], paths: ["src/repo/yarn-*.ts"] },
    { area: "Rust", maintainers: ["FredApps"], paths: ["tests/**/rust-*.test.ts"] },
  ],
});

describe("request area reviews", () => {
  it("matches * within a segment and ** across segments", () => {
    assert.ok(globToRegExp("src/repo/yarn-*.ts").test("src/repo/yarn-lockfile.ts"));
    assert.ok(!globToRegExp("src/repo/yarn-*.ts").test("src/repo/yarn-x/a.ts"));
    assert.ok(globToRegExp("tests/**/rust-*.test.ts").test("tests/rust-a.test.ts"));
    assert.ok(globToRegExp("tests/**/rust-*.test.ts").test("tests/repo/deep/rust-a.test.ts"));
    assert.ok(!globToRegExp("src/a.ts").test("src/aXts"));
  });

  it("requests the maintainers of every touched area", () => {
    const files = ["src/repo/yarn-lockfile.ts", "tests/repo/rust-adapter.test.ts", "README.md"];
    assert.deepEqual(reviewersToRequest({ areas, author: "someone", files, involved: [] }), ["KingEmma7", "FredApps"]);
  });

  it("requests nobody when no area is touched", () => {
    assert.deepEqual(reviewersToRequest({ areas, author: "someone", files: ["src/cli.ts"], involved: [] }), []);
  });

  it("skips the author and anyone already requested or reviewing, ignoring case", () => {
    const files = ["src/repo/yarn-lockfile.ts", "tests/repo/rust-adapter.test.ts"];
    assert.deepEqual(reviewersToRequest({ areas, author: "kingemma7", files, involved: [] }), ["FredApps"]);
    assert.deepEqual(reviewersToRequest({ areas, author: "someone", files, involved: ["fredapps"] }), ["KingEmma7"]);
  });

  it("counts past requests, including removed ones, and reviews as involvement", () => {
    const timeline = [
      { event: "review_requested", requested_reviewer: { login: "KingEmma7" } },
      { event: "review_request_removed", requested_reviewer: { login: "KingEmma7" } },
      { event: "reviewed", user: { login: "FredApps" } },
      { event: "commented", user: { login: "other" } },
    ];
    assert.deepEqual(involvedLogins(timeline).sort(), ["FredApps", "KingEmma7"]);
  });

  it("rejects malformed entries", () => {
    assert.throws(() => parseAreas({ areas: [{ area: "X", maintainers: [], paths: ["a"] }] }));
    assert.throws(() => parseAreas({ areas: [{ area: "X", maintainers: ["a b"], paths: ["a"] }] }));
    assert.throws(() => parseAreas({}));
  });

  it("every pattern in .github/area-maintainers.json matches a tracked file", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n");
    const unmatched = parseAreas(config).flatMap(({ area, patterns }: { area: string; patterns: RegExp[] }) =>
      patterns.filter((pattern) => !tracked.some((file) => pattern.test(file))).map((pattern) => `${area}: ${pattern}`),
    );
    assert.deepEqual(unmatched, []);
  });
});
