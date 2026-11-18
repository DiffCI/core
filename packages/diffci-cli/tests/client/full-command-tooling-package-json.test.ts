import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inferFullCommand } from "../../src/client/full-command.js";

const hasPython = [["python3"], ["python"], ["py", "-3"]].some((candidate) => spawnSync(candidate[0]!, [...candidate.slice(1), "-c", "print(1)"], { encoding: "utf8" }).status === 0);

/** A package.json kept only for tooling (formatters, git hooks), with no test script. */
const TOOLING_PACKAGE = JSON.stringify({ private: true, devDependencies: { prettier: "3.0.0" } });

function withRepository(files: Record<string, string>, check: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "diffci-full-tooling-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a Go module with a tooling-only package.json runs go test as its full command", () => {
  withRepository({ "go.mod": "module example.com/x\n\ngo 1.22\n", "package.json": TOOLING_PACKAGE }, (dir) => {
    assert.deepEqual(inferFullCommand(dir), { command: "go test ./...", reason: "root Go module" });
  });
});

test("a Python project with a tooling-only package.json runs pytest as its full command", { skip: hasPython ? false : "no Python on PATH" }, () => {
  withRepository({ "pyproject.toml": "[project]\nname = \"x\"\n", "package.json": TOOLING_PACKAGE }, (dir) => {
    const decision = inferFullCommand(dir);
    assert.match(decision.command ?? "", /^(?:python3|python|py -3) -m pytest$/);
    assert.equal(decision.reason, "Python project tested with pytest");
  });
});

test("a package.json without a test script and no other project still has no full command", () => {
  withRepository({ "package.json": TOOLING_PACKAGE }, (dir) => {
    assert.deepEqual(inferFullCommand(dir), { reason: "package.json has no test script" });
  });
});

test("a package.json test script still wins over go.mod", () => {
  withRepository({ "go.mod": "module example.com/x\n", "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, (dir) => {
    assert.deepEqual(inferFullCommand(dir), { command: "npm test", reason: "package.json test script" });
  });
});
