import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
// @ts-expect-error plain ESM script without type declarations
import { contributorTiers, creditReadme, README_TIERS, summarize, withHandLanded } from "../scripts/credit-contributors.mjs";

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

  it("credits a pull request a maintainer squashed onto main by hand, only for its own author", () => {
    const closed = (number: number, login: string) => pr(number, login, "fix: landed", { merged_at: null });
    const commit = (title: string, login: string | null) => ({ commit: { message: `${title}\n\nSigned-off-by: x` }, author: login ? { login } : null });
    const pulls = withHandLanded(
      [closed(160, "Sam"), closed(161, "sam"), closed(162, "sam"), closed(163, "sam")],
      [commit("fix: landed (#160)", "sam"), commit("fix: landed (#161)", "someone-else"), commit("fix: landed (#162)", null), commit("fix: #163 mentioned (#999)", "sam")],
    );
    assert.deepEqual(creditReadme(readme, pulls).credited, [{ login: "Sam", number: 160 }]);
  });

  it("strips conventional prefixes", () => {
    assert.equal(summarize("fix(git-diff)!: run every test."), "run every test");
  });

  it("finds the live README's Contributors list", () => {
    const live = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.deepEqual(creditReadme(live, []).credited, []);
  });

  it("reads tier labels after the name and rejects unknown tiers", () => {
    const tierReadme = (label: string) => `### Contributors\n\n- **[@sam](https://github.com/Sam)**${label}: a fix ([#1](x)).\n- **[Pat Lee](https://github.com/pat)**: a fix.\n`;
    assert.deepEqual(contributorTiers(tierReadme(", **[Area maintainer: Rust](CONTRIBUTING.md#contributor-tiers)**")), { sam: "Area maintainer: Rust", pat: "Contributor" });
    assert.deepEqual(contributorTiers(tierReadme(", **[Regular contributor](CONTRIBUTING.md#contributor-tiers)**")).sam, "Regular contributor");
    for (const bad of ["Maintainer: Rust", "Area maintainer", "Regular contributor: Go"]) {
      assert.throws(() => contributorTiers(tierReadme(`, **[${bad}](CONTRIBUTING.md#contributor-tiers)**`)), /unknown tier label/);
    }
  });

  it("keeps a tier label when a pull request is appended", () => {
    const tiered = "### Contributors\n\n- **[@sam](https://github.com/sam)**, **[Area maintainer: Rust](CONTRIBUTING.md#contributor-tiers)**: a fix ([#131](x)).\n";
    const next = creditReadme(tiered, [{ number: 140, title: "feat(rust): more", merged_at: "2026-11-15T00:00:00Z", author_association: "CONTRIBUTOR", user: { login: "sam", type: "User" } }]).readme;
    assert.equal(contributorTiers(next).sam, "Area maintainer: Rust");
  });

  it("uses only CONTRIBUTING.md tier names in the live README", () => {
    const contributing = readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
    for (const tier of README_TIERS) assert.match(contributing, new RegExp(`^\\| \\*\\*${tier}\\*\\* \\|`, "m"), tier);
    const tiers = contributorTiers(readFileSync(new URL("../README.md", import.meta.url), "utf8"));
    assert.equal(tiers.fredapps, "Area maintainer: Rust");
  });
});
