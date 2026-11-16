// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fallbackReasons, noCommandReasons } from "../scripts/fallback-reasons.mjs";

describe("fallback reason documentation", () => {
  it("lists every fallback reason in docs/using-diffci.md", () => {
    const docs = readFileSync(new URL("../docs/using-diffci.md", import.meta.url), "utf8");
    const reasons = fallbackReasons();
    assert.ok(reasons.size > 50, `only ${reasons.size} reasons found; the extractor in scripts/fallback-reasons.mjs is probably broken`);
    const missing = [...reasons].filter(([text]) => !docs.includes(`\`${text}\``)).map(([text, where]) => `${where}  ${text}`);
    assert.deepEqual(missing, [], "add these reasons to the Fallback reasons table in docs/using-diffci.md");
  });

  it("lists every no-runnable-command reason in docs/using-diffci.md (#127)", () => {
    const docs = readFileSync(new URL("../docs/using-diffci.md", import.meta.url), "utf8");
    const section = docs.slice(docs.indexOf("### No runnable command"));
    const reasons = noCommandReasons();
    assert.ok(reasons.size > 15, `only ${reasons.size} reasons found; noCommandReasons in scripts/fallback-reasons.mjs is probably broken`);
    const missing = [...reasons].filter(([text]) => !section.includes(`| \`${text}\` |`)).map(([text, where]) => `${where}  ${text}`);
    assert.deepEqual(missing, [], "add these reasons to the No runnable command table in docs/using-diffci.md");
  });
});
