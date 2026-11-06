import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inferFullCommand } from "../../src/client/full-command.js";

const hasPython = [["python3"], ["python"], ["py", "-3"]].some((candidate) => spawnSync(candidate[0]!, [...candidate.slice(1), "-c", "print(1)"], { encoding: "utf8" }).status === 0);

test("a Python project's full command is pytest through the interpreter on PATH (2026-11-06)", { skip: hasPython ? false : "no Python on PATH" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-python-full-"));
  try {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = \"x\"\n");
    const decision = inferFullCommand(dir);
    assert.match(decision.command ?? "", /^(?:python3|python|py -3) -m pytest$/);
    assert.equal(decision.reason, "Python project tested with pytest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
