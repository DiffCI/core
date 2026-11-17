// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveScript } from "../../src/ci-inference/resolve.js";

function resolveIn(scripts: Record<string, string>, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "diffci-script-pm-verbs-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
    return resolveScript(dir, name, { file: ".github/workflows/ci.yml", text: `npm run ${name}` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const unresolvedNames = (nodes: ReturnType<typeof resolveIn>) => nodes.slice(1).filter((n) => n.resolution !== "RESOLVED").map((n) => n.identifier);

test("an install or builtin verb inside a script is not a script reference", () => {
  for (const body of ["yarn install && yarn run build", "pnpm install --frozen-lockfile && pnpm build", "yarn --frozen-lockfile && yarn build", "yarn why react && yarn build"]) {
    const nodes = resolveIn({ ci: body, build: "tsc" }, "ci");
    assert.deepEqual(unresolvedNames(nodes), [], body);
    assert.equal(nodes[0]!.resolution, "RESOLVED", body);
  }
});

test("a flag before the script name is not a script name", () => {
  assert.deepEqual(unresolvedNames(resolveIn({ ci: "pnpm -r build", build: "tsc" }, "ci")), []);
  assert.deepEqual(unresolvedNames(resolveIn({ ci: "npm run -s build", build: "tsc" }, "ci")), []);
});

test("a missing nested script is still unresolved", () => {
  assert.deepEqual(unresolvedNames(resolveIn({ ci: "yarn install && yarn lint" }, "ci")), ["lint"]);
});

test("a script reached through two branches is not a cycle", () => {
  const nodes = resolveIn({ ci: "npm run build && npm run test", test: "npm run build && jest", build: "tsc" }, "ci");
  assert.equal(nodes[0]!.resolution, "RESOLVED", JSON.stringify(nodes.filter((n) => n.resolution !== "RESOLVED")));
  assert.ok(!nodes.some((n) => /cycle/.test(n.reason ?? "")));
});
