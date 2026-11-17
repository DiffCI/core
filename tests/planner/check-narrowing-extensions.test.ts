// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { narrowGateChecks } from "../../src/planner/check-narrowing.js";
import { discoverGateChecks } from "../../src/planner/pipeline-steps.js";

function decide(config: Record<string, string>, changed: string, lint = "eslint src") {
  const scripts = { lint };
  const [check] = narrowGateChecks(discoverGateChecks(scripts).checks, {
    scripts,
    changes: [{ path: changed, status: "modified" }],
    read: (path) => config[path],
  });
  return [check!.decision, check!.command];
}

const VUE = 'import js from "@eslint/js";\nimport vue from "eslint-plugin-vue";\nexport default [js.configs.recommended, ...vue.configs["flat/recommended"]];\n';

describe("ESLint directory targets lint the file types their configuration adds", () => {
  it("does not skip `eslint src` when a .vue file changed and the config uses eslint-plugin-vue", () => {
    assert.deepEqual(decide({ "eslint.config.js": VUE }, "src/App.vue"), ["NARROWED", "eslint src/App.vue"]);
  });

  it("counts a type the config names by an alias, or in an eslintrc override", () => {
    const markdown = 'import markdown from "@eslint/markdown";\nexport default [...markdown.configs.recommended];';
    assert.deepEqual(decide({ "eslint.config.mjs": markdown }, "src/guide.md"), ["NARROWED", "eslint src/guide.md"]);
    const svelte = '{ "overrides": [{ "files": ["*.svelte"], "parser": "svelte-eslint-parser" }] }';
    assert.deepEqual(decide({ ".eslintrc.json": svelte }, "src/App.svelte"), ["NARROWED", "eslint src/App.svelte"]);
  });

  it("still skips types the configuration never mentions", () => {
    assert.deepEqual(decide({ "eslint.config.js": VUE }, "src/style.css"), ["SKIP", "eslint src"]);
    assert.deepEqual(decide({ "eslint.config.js": VUE }, "docs/App.vue"), ["SKIP", "eslint src"]);
  });
});
