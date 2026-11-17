// CodeQL alert 36 (2026-11-17): the scoped verify command is pasted into the agent's shell as written.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shellPath } from "../../src/client/agent-selection.js";

describe("shellPath", () => {
  it("returns no shell word for a path that no quoting keeps literal", () => {
    assert.equal(shellPath("src/a.ts"), "src/a.ts");
    assert.equal(shellPath("docs/my file.md"), '"docs/my file.md"');
    for (const path of ["$(touch pwned).ts", "a`id`.ts", 'a".ts', "a\\b.ts", "%PATH%.ts", "a!b.ts", "a\nb.ts"]) {
      assert.equal(shellPath(path), undefined, path);
    }
  });
});
