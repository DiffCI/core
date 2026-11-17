import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { it } from "node:test";

import { measureCommands } from "../../src/client/command-batches.js";
import { measureCommand } from "../../src/client/verify-savings.js";

const print = (text: string) => `node -e "process.stdout.write(${JSON.stringify(text).replace(/"/g, "'")}); process.stderr.write('err')"`;

it("--tail-bytes 0 keeps no output, whether a selection runs as one command or several", () => {
  const options = { cwd: tmpdir(), timeoutMs: 60_000, tailBytes: 0 };
  for (const measurement of [measureCommand(print("hello"), options), measureCommands([print("hello")], options), measureCommands([print("a"), print("b")], options)]) {
    assert.equal(measurement.exitCode, 0, measurement.stderrTail);
    assert.equal(measurement.stdoutTail, "");
    assert.equal(measurement.stderrTail, "");
  }
});

it("a tail is at most tailBytes bytes and never starts inside a character", () => {
  const measurement = measureCommand(print("abc\u00e9\u00e9\u00e9"), { cwd: tmpdir(), timeoutMs: 60_000, tailBytes: 3 });
  assert.equal(measurement.stdoutTail, "\u00e9");
  assert.ok(Buffer.byteLength(measurement.stdoutTail, "utf8") <= 3);
  assert.equal(measureCommand(print("abcdef"), { cwd: tmpdir(), timeoutMs: 60_000, tailBytes: 4 }).stdoutTail, "cdef");
});
