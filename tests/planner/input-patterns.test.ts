// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";

import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import type { CIPlannerInput } from "../../src/planner/types.js";

/** Plans one changed file against one task whose only input is `pattern`, and returns that task's decision. */
function decide(pattern: string, path: string) {
  const registry = createTaskRegistry([{ id: "task", command: "npm run lint", category: "lint", inputPatterns: [pattern] }]);
  const input = {
    delta: { files: [{ path, status: "modified" }] },
    impact: { fallbackRequired: false, fallbackReasons: [], affectedTests: [], evidence: [], riskSignals: [] },
    profile: { testFilePaths: [] },
  } as unknown as CIPlannerInput;
  return new DefaultCIPlanner(registry).plan(input).tasks.find((task) => task.id === "task")!;
}

test("`**` not next to a slash matches at any depth, as in GitHub's `**.js` path filter", () => {
  assert.equal(decide("**.js", "src/lib/deep/index.js").status, "RUN");
  assert.equal(decide("**", "packages/core/src/index.ts").status, "RUN");
  assert.equal(decide("src/**.ts", "src/a/b.ts").status, "RUN");
  assert.equal(decide("**.js", "src/index.ts").status, "SKIP_CANDIDATE");
});

test("regex-only characters in a pattern match themselves", () => {
  assert.equal(decide("app/(marketing)/**", "app/(marketing)/about/page.tsx").status, "RUN");
  assert.equal(decide("app/routes/$slug.tsx", "app/routes/$slug.tsx").status, "RUN");
  assert.equal(decide("app/(marketing)/**", "app/marketing/about/page.tsx").status, "SKIP_CANDIDATE");
});

test("`+` is literal, `?` is one character, and classes and escapes work as in the research matcher (#178)", () => {
  assert.equal(decide("c++/**", "c++/main.cc").status, "RUN");
  assert.equal(decide("c++/**", "src/main.cc").status, "SKIP_CANDIDATE");
  assert.equal(decide("src/?.ts", "src/a.ts").status, "RUN");
  assert.equal(decide("src/?.ts", "src/ab.ts").status, "SKIP_CANDIDATE");
  assert.equal(decide("src/v[0-9].ts", "src/v2.ts").status, "RUN");
  assert.equal(decide("src/v[!0-9].ts", "src/v2.ts").status, "SKIP_CANDIDATE");
  assert.equal(decide("app/\\[id\\]/*", "app/[id]/page.tsx").status, "RUN");
});

test("a pattern that is not a valid filter triggers the task instead of throwing", () => {
  assert.equal(decide("src/[z-a].ts", "docs/readme.md").status, "RUN");
});

test("existing globstar forms are unchanged", () => {
  assert.equal(decide("src/**/*", "src/a/b/c.ts").status, "RUN");
  assert.equal(decide("src/**/*.test.ts", "src/a/b/c.test.ts").status, "RUN");
  assert.equal(decide("src/**", "src").status, "RUN");
  assert.equal(decide("**/__tests__/**/*", "pkg/__tests__/x/y.ts").status, "RUN");
  assert.equal(decide("src/*.ts", "src/a/b.ts").status, "SKIP_CANDIDATE");
});
