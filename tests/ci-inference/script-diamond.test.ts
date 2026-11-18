// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveScript } from "../../src/ci-inference/resolve.js";

function resolveIn(scripts: Record<string, string>, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "diffci-script-diamond-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
    return resolveScript(dir, name, { file: ".github/workflows/ci.yml", text: `npm run ${name}` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a script reached through two branches is not a cycle", () => {
  const nodes = resolveIn({ ci: "npm run build && npm run test", test: "npm run build && jest", build: "tsc" }, "ci");
  assert.equal(nodes[0]!.resolution, "RESOLVED", JSON.stringify(nodes.filter((n) => n.resolution !== "RESOLVED")));
  assert.ok(!nodes.some((n) => /cycle/.test(n.reason ?? "")));
});

test("a real cycle is still unresolvable", () => {
  const nodes = resolveIn({ a: "npm run b", b: "npm run a" }, "a");
  assert.equal(nodes[0]!.resolution, "UNRESOLVED");
  assert.ok(nodes.some((n) => n.resolution === "UNRESOLVABLE" && n.reason === "script cycle through a"));
});
