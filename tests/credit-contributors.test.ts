import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
// @ts-expect-error plain ESM script without type declarations
import { creditReadme, summarize } from "../scripts/credit-contributors.mjs";

const readme = [
  "# DiffCI",
  "",
  "### Contributors",
  "",
  "Thank you to everyone who has improved DiffCI:",
  "",
  "- **[@sam](https://github.com/sam)**: a fix ([#118](https://github.com/DiffCI/core/pull/118)–[#120](https://github.com/DiffCI/core/pull/120)).",
  "",
  "Every merged contribution is credited.",
  "",
].join("\n");

const pr = (number: number, login: string, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  merged_at: "2026-11-14T00:00:00Z",
  author_association: "CONTRIBUTOR",
  user: { login, type: "User" },
  ...extra,
});

describe("credit contributors", () => {
  it("adds a first-time contributor at the end of the list", () => {
    const { readme: next, credited } = creditReadme(readme, [pr(140, "newbie", "fix(cli): list every command")]);
    assert.deepEqual(credited, [{ login: "newbie", number: 140 }]);
    const lines = next.split("\n");
    assert.match(lines[7], /^- <a href="https:\/\/github.com\/newbie">.*\*\*\[@newbie\]\(https:\/\/github.com\/newbie\)\*\*: list every command \(\[#140\]\(https:\/\/github.com\/DiffCI\/core\/pull\/140\)\)\.$/);
    assert.equal(lines[8], "");
  });

  it("appends to an existing entry and is idempotent", () => {
    const once = creditReadme(readme, [pr(141, "Sam", "feat: more")]).readme;
    assert.match(once, /\[#120\]\([^)]*\)\); more \(\[#141\]\([^)]*\)\)\.\n/);
    assert.deepEqual(creditReadme(once, [pr(141, "Sam", "feat: more")]).credited, []);
  });

  it("skips maintainers, bots, unmerged, already linked and hand-credited pull requests", () => {
    const { credited } = creditReadme(readme, [
      pr(150, "adityankale190895", "fix: x"),
      pr(151, "dependabot[bot]", "build: y", { user: { login: "dependabot[bot]", type: "Bot" } }),
      pr(152, "member", "fix: z", { author_association: "MEMBER" }),
      pr(153, "open", "fix: w", { merged_at: null }),
      pr(119, "sam", "fix: inside a range"),
      pr(140, "sam", "fix: in range? no, but under the first automated PR", { number: 129 }),
    ]);
    assert.deepEqual(credited, []);
  });

  it("strips conventional prefixes", () => {
    assert.equal(summarize("fix(git-diff)!: run every test."), "run every test");
  });

  it("finds the live README's Contributors list", () => {
    const live = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.deepEqual(creditReadme(live, []).credited, []);
  });
});
