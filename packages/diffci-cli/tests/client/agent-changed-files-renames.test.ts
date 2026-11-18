import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentChangedFiles } from "../../src/client/agent-selection.js";

test("diffci_changed_files lists both paths of a renamed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-agent-renames-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    git("init", "--quiet");
    git("config", "user.email", "test@diffci.local");
    git("config", "user.name", "Test");
    // Rename detection is on by default; set it explicitly so a global diff.renames=false cannot hide the bug.
    git("config", "diff.renames", "true");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "old.ts"), Array.from({ length: 40 }, (_, line) => `export const v${line} = ${line};\n`).join(""));
    git("add", "-A");
    git("commit", "--quiet", "-m", "initial");
    git("mv", "src/old.ts", "src/new.ts");
    const changes = agentChangedFiles(dir);
    assert.equal(changes.status, "observed");
    // The old path is gone: anything that imports it is affected, so it is a changed file too.
    assert.deepEqual([...changes.changed_files].sort(), ["src/new.ts", "src/old.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
