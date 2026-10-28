// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { batchCommand, measureCommands } from "../packages/diffci-cli/src/client/command-batches.js";

describe("batchCommand", () => {
  const paths = Array.from({ length: 10 }, (_, i) => `tests/suite-${String(i).padStart(2, "0")}.test.ts`);
  const command = `npx --no-install tsx --test ${paths.join(" ")}`;

  it("leaves a command within the limit whole", () => {
    assert.deepEqual(batchCommand(command, paths, 10_000), [command]);
  });

  it("splits the trailing test paths across invocations of the same runner", () => {
    const parts = batchCommand(command, paths, 120);
    assert.ok(parts.length > 1);
    for (const part of parts) {
      assert.ok(part.length <= 120, part);
      assert.ok(part.startsWith("npx --no-install tsx --test "));
    }
    assert.deepEqual(parts.flatMap((part) => part.split(" ").slice(4)), paths);
  });

  it("does not rewrite a command whose tail is not exactly the selected paths", () => {
    const quoted = `vitest run --config "my config.ts" ${paths.join(" ")} --reporter=dot`;
    assert.deepEqual(batchCommand(quoted, paths, 120), [quoted]);
    assert.deepEqual(batchCommand(command, [], 120), [command]);
  });
});

describe("measureCommands", () => {
  // Real selections start with a bare runner name; a quoted absolute path is altered by cmd /s /c.
  const node = "node";

  it("runs every part, reports the first failure and keeps the joined command", () => {
    const result = measureCommands([`${node} -e "process.exit(0)"`, `${node} -e "process.exit(3)"`, `${node} -e "process.exit(0)"`], { cwd: process.cwd(), timeoutMs: 60_000, tailBytes: 1000 });
    assert.equal(result.exitCode, 3);
    assert.equal(result.timedOut, false);
    assert.match(result.command, / && .* && /);
  });

  it("runs a 191-file selection that exceeds the Windows command-line limit", () => {
    const dir = join(tmpdir(), `diffci-batches-${randomUUID()}`);
    try {
      mkdirSync(join(dir, "tests", "a-fairly-long-directory-name-to-push-the-command-length"), { recursive: true });
      const files = Array.from({ length: 191 }, (_, i) => `tests/a-fairly-long-directory-name-to-push-the-command-length/case-${i}.test.mjs`);
      for (const file of files) writeFileSync(join(dir, file), `import test from "node:test";\ntest("ok", () => {});\n`);
      const command = `${node} --test ${files.join(" ")}`;
      assert.ok(command.length > 8191, `command is ${command.length} characters`);
      const parts = batchCommand(command, files, 8000);
      assert.ok(parts.length > 1);
      const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
      const saved = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;
      try {
        const result = measureCommands(parts, { cwd: dir, timeoutMs: 300_000, tailBytes: 2000 });
        assert.equal(result.exitCode, 0, result.stderrTail || result.stdoutTail);
        assert.match(result.stdoutTail, /pass/);
      } finally {
        if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
        void env;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
