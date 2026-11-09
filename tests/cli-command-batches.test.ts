// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { batchCommand, COMMAND_LINE_LIMIT, measureCommands } from "../packages/diffci-cli/src/client/command-batches.js";
import { windowsLaunch, withPathEntry } from "../packages/diffci-cli/src/client/node-bin-launch.js";

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

describe("long selections through repository-local runners", () => {
  // DentalPresence, 2026-11-09: 282 of 625 files selected, about 12,300 characters, run as
  // `npx --no-install tsx --test <files>`. On Windows `npx.cmd` and `tsx.cmd` re-expand the arguments
  // into further cmd.exe lines, escaping quoted globs such as "src/app/@([(])public@([)])/x.test.ts"
  // with `^`, so a 7,989-character part failed with exit 255 before any test ran.
  const linkNodeModules = (dir: string) => symlinkSync(resolve("node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const body = (name: string, fails = false) => `import test from "node:test";
test(${JSON.stringify(name)}, () => { ${fails ? 'throw new Error("boom");' : ""} });
`;

  it("runs a 282-file npx tsx selection over 8,191 characters, quoted globs included", () => {
    const dir = join(tmpdir(), `diffci-npx-batches-${randomUUID()}`);
    try {
      mkdirSync(join(dir, "src", "lib", "directory"), { recursive: true });
      // The repository's own node_modules, with npm's real `.bin` shims for tsx.
      linkNodeModules(dir);
      const files = Array.from({ length: 282 }, (_, i) => `src/lib/directory/publication-region-layer-case-${String(i).padStart(3, "0")}.test.ts`);
      for (const file of files) writeFileSync(join(dir, file), body(file));
      // Next.js route groups and catch-all segments, as Core's planner quotes them for node --test.
      const special = ["src/app/(public)/homepage-seo.test.ts", "src/app/ingest/[...path]/route.test.ts", "src/app/(site)/[slug]/page.test.ts"];
      for (const file of special) {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), body(file));
      }
      const glob = (path: string) => `"${path.replace(/[[\]()]/g, (c) => `@([${c}])`)}"`;
      const tokens = [...special.map(glob), ...files];
      const command = `npx --no-install tsx --conditions react-server --test ${tokens.join(" ")}`;
      assert.ok(command.length > 8191, `command is ${command.length} characters`);
      const paths = [...special, ...files];
      // Windows' limit on every platform: elsewhere COMMAND_LINE_LIMIT never splits this selection, and
      // the parts must run the same on Linux CI as on Windows.
      const limit = Math.min(COMMAND_LINE_LIMIT, 6000);
      const parts = batchCommand(command, paths, limit);
      assert.ok(parts.length > 1);
      for (const part of parts) assert.ok(part.length <= limit && part.length < 8191, `part is ${part.length} characters`);
      assert.deepEqual(parts.flatMap((part) => part.split(" ").slice(6)), tokens);
      const result = measureCommands(parts, { cwd: dir, timeoutMs: 300_000, tailBytes: 4000 });
      assert.equal(result.exitCode, 0, result.stderrTail || result.stdoutTail);
      assert.equal(result.runnerTestCount, paths.length, result.stdoutTail);
      assert.equal(result.command, parts.join(" && "));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Through `npx.cmd` and `tsx.cmd` a line stops working at about 7,950 characters, below cmd.exe's own
  // 8,191, so a part the batching allowed (at most 8,000 until 2026-11-09) could still fail.
  it("runs a part that fits cmd.exe but not the runner's .cmd shims", () => {
    const dir = join(tmpdir(), `diffci-npx-shim-${randomUUID()}`);
    try {
      mkdirSync(join(dir, "src", "lib", "directory"), { recursive: true });
      linkNodeModules(dir);
      const files = Array.from({ length: 400 }, (_, i) => `src/lib/directory/publication-region-layer-case-${String(i).padStart(3, "0")}.test.ts`);
      let command = "npx --no-install tsx --conditions react-server --test";
      const used: string[] = [];
      for (const file of files) {
        if (command.length + 1 + file.length > 8100) break;
        command += ` ${file}`;
        used.push(file);
        writeFileSync(join(dir, file), body(file));
      }
      assert.ok(command.length > 8000 && command.length < 8191, `command is ${command.length} characters`);
      const result = measureCommands([command], { cwd: dir, timeoutMs: 300_000, tailBytes: 4000 });
      assert.equal(result.exitCode, 0, result.stderrTail || result.stdoutTail);
      assert.equal(result.runnerTestCount, used.length, result.stdoutTail);
      assert.equal(result.command, command);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the failing part's exit code and failures across parts", () => {
    const dir = join(tmpdir(), `diffci-npx-exit-${randomUUID()}`);
    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      linkNodeModules(dir);
      const files = Array.from({ length: 6 }, (_, i) => `tests/case-${i}.test.ts`);
      files.forEach((file, i) => writeFileSync(join(dir, file), body(`t${i}`, i === 2)));
      const parts = batchCommand(`npx --no-install tsx --test ${files.join(" ")}`, files, 80);
      assert.ok(parts.length > 2);
      const result = measureCommands(parts, { cwd: dir, timeoutMs: 300_000, tailBytes: 4000 });
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.failingTests, ["t2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("windowsLaunch", () => {
  const fixture = (shim: string, files: Record<string, string> = {}) => {
    const dir = join(tmpdir(), `diffci-launch-${randomUUID()}`);
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "runner"), shim);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  const npmShim = `#!/bin/sh
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/../runner-pkg/dist/cli.mjs" "$@"
else 
  exec node  "$basedir/../runner-pkg/dist/cli.mjs" "$@"
fi
`;

  it("starts a JavaScript bin with node and puts node_modules/.bin on PATH", () => {
    const dir = fixture(npmShim, { "node_modules/runner-pkg/dist/cli.mjs": "" });
    try {
      const launch = windowsLaunch("npx --no-install runner --test a.test.ts b.test.ts", dir);
      assert.equal(launch.command, "node node_modules/runner-pkg/dist/cli.mjs --test a.test.ts b.test.ts");
      assert.equal(launch.pathEntry, join(dir, "node_modules", ".bin"));
      // A package directory below the working directory still finds the repository's runner.
      mkdirSync(join(dir, "packages", "app"), { recursive: true });
      assert.equal(windowsLaunch("npx --no-install runner x", join(dir, "packages", "app")).command, "node ../../node_modules/runner-pkg/dist/cli.mjs x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves commands it cannot resolve unchanged", () => {
    const native = fixture(`#!/bin/sh
exec "$basedir/../runner-pkg/bin/runner.exe" "$@"
`, { "node_modules/runner-pkg/bin/runner.exe": "" });
    const missing = fixture(npmShim);
    try {
      for (const command of ["npx --no-install runner x", "node --test x", "npx runner x", "npm test"]) {
        assert.deepEqual(windowsLaunch(command, native), { command });
      }
      assert.deepEqual(windowsLaunch("npx --no-install runner x", missing), { command: "npx --no-install runner x" });
      assert.deepEqual(windowsLaunch("npx --no-install other x", missing), { command: "npx --no-install other x" });
    } finally {
      rmSync(native, { recursive: true, force: true });
      rmSync(missing, { recursive: true, force: true });
    }
  });

  it("prepends to PATH under the key the environment already uses", () => {
    assert.deepEqual(withPathEntry({ Path: "C:/a", X: "1" }, "C:/bin"), { Path: `C:/bin${delimiter}C:/a`, X: "1" });
    assert.deepEqual(withPathEntry({}, "/bin"), { PATH: "/bin" });
  });
});
