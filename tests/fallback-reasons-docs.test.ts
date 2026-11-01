// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fallbackReasons } from "../scripts/fallback-reasons.mjs";

describe("fallback reason documentation", () => {
  it("lists every fallback reason in docs/using-diffci.md", () => {
    const docs = readFileSync(new URL("../docs/using-diffci.md", import.meta.url), "utf8");
    const reasons = fallbackReasons();
    assert.ok(reasons.size > 50, `only ${reasons.size} reasons found; the extractor in scripts/fallback-reasons.mjs is probably broken`);
    const missing = [...reasons].filter(([text]) => !docs.includes(`\`${text}\``)).map(([text, where]) => `${where}  ${text}`);
    assert.deepEqual(missing, [], "add these reasons to the Fallback reasons table in docs/using-diffci.md");
  });
});
