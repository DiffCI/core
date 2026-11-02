import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, relative, sep } from "node:path";

/**
 * Selected tests the runner would never execute (2026-11-01).
 *
 * WHY. `node --test` reads every file argument as a glob. A selected `src/app/ingest/[...path]/route.test.ts`
 * passed as written is a character class that matches nothing; the other selected files still ran, so
 * the verification exited 0 and reported passed while the one test that covered the change never ran
 * (DentalPresence ebac4289f73a, CLI 0.3.21). Selection was right; execution silently was not.
 *
 * WHAT. Before running, each selected file is matched against the patterns the command hands
 * `node --test`, the way Node's own glob matches them; a file no pattern claims means the selection is
 * not executable as written. After running, the runner's own count is checked: a summary reporting
 * fewer tests (node:test) or test files (vitest, jest) than files were selected means some never ran.
 *
 * 2026-11-02. Both checks passed under CLI 0.3.22 while the file still never ran on Linux. The command
 * was `npx --no-install tsx --test "...[[]...path[]]..."`, and npx hands its arguments to a second
 * `sh -c`, quoting only those with characters such as `(`, `*` or a space; that shell expanded the
 * unquoted class back to the real `[...path]` directory. The pre-run check now models that second
 * shell. The count check could not see one missing file among 120 tests, so a `node --test` selection
 * also runs with a probe that records the file each test process started for (`traceNodeTestFiles`),
 * and a selected file that never started blocks the verification.
 */

/** The arguments `sh` (or `cmd.exe` on Windows) would hand the program, for the quoting DiffCI emits. */
export function commandArguments(command: string, windows = process.platform === "win32"): string[] {
  const args: string[] = [];
  let current: string | undefined;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      else if (!windows && quote === "\"" && character === "\\" && /["$`\\]/.test(command[index + 1] ?? "")) current += command[++index]!;
      else current += character;
    } else if (/\s/.test(character)) {
      if (current !== undefined) args.push(current);
      current = undefined;
    } else if (character === "\"" || (!windows && character === "'")) {
      quote = character;
      current ??= "";
    } else if (!windows && character === "\\" && index + 1 < command.length) {
      current = (current ?? "") + command[++index]!;
    } else {
      current = (current ?? "") + character;
    }
  }
  if (current !== undefined) args.push(current);
  return args;
}

/** Arguments npm's `sh` escaping leaves unquoted when npx re-runs a bin through `sh -c`
 * (@npmcli/promise-spawn): those without whitespace or any of ``"#$&'()*;<>?\`|~``. */
const NPM_UNQUOTED = /^[^\s"#$&'()*;<>?\\`|~]+$/;

/** The file patterns of each `node --test` invocation in `command` (directly, or through tsx). Paths
 * npx passes to a second `sh` unquoted are marked: that shell expands a pattern that matches files. */
function nodeTestPatterns(command: string, windows: boolean): Array<{ pattern: string; reglobbed: boolean }> {
  const patterns: Array<{ pattern: string; reglobbed: boolean }> = [];
  let segment: string[] = [];
  for (const arg of [...commandArguments(command, windows), "&&"]) {
    if (arg !== "&&") { segment.push(arg); continue; }
    const testFlag = segment.indexOf("--test");
    if (testFlag > 0 && (segment[0] === "node" || segment.slice(0, testFlag).includes("tsx"))) {
      const viaNpx = !windows && (segment[0] === "npx" || (segment[0] === "npm" && segment[1] === "exec"));
      for (const pattern of segment.slice(testFlag + 1).filter((value) => !value.startsWith("-"))) {
        patterns.push({ pattern, reglobbed: viaNpx && NPM_UNQUOTED.test(pattern) });
      }
    }
    segment = [];
  }
  return patterns;
}

/** Whether node --test, handed `pattern` by `command`, would run `path`. A pattern the second shell
 * expands reaches node as the literal path it matched, which node then reads as a glob again. */
function claims({ pattern, reglobbed }: { pattern: string; reglobbed: boolean }, path: string): boolean {
  return matchesGlob(path, pattern) && (!reglobbed || matchesGlob(path, path));
}

/** Selected files no `node --test` pattern in `command` matches. Empty when `command` runs no `node --test`. */
export function unmatchedNodeTests(command: string, selectedTests: readonly string[], windows = process.platform === "win32"): string[] {
  const patterns = nodeTestPatterns(command, windows);
  if (patterns.length === 0) return [];
  return selectedTests.filter((path) => !patterns.some((pattern) => claims(pattern, path)));
}

/** Selected files `command` hands `node --test`, which the trace from `traceNodeTestFiles` must show. */
export function selectedNodeTests(command: string, selectedTests: readonly string[], windows = process.platform === "win32"): string[] {
  const patterns = nodeTestPatterns(command, windows);
  return selectedTests.filter((path) => patterns.some(({ pattern }) => pattern === path || matchesGlob(path, pattern)));
}

/** Records the file each node:test process starts for. node --test runs every file in a child process
 * with NODE_TEST_CONTEXT set and the file as argv[1]; NODE_OPTIONS reaches it through npx and tsx.
 * Under `--test-isolation=none` no child starts and the trace stays empty, which proves nothing. */
const PROBE = `"use strict";
if (process.env.NODE_TEST_CONTEXT && process.argv[1] && process.env.DIFFCI_NODE_TEST_TRACE) {
  try { require("node:fs").appendFileSync(process.env.DIFFCI_NODE_TEST_TRACE, process.argv[1] + "\\n"); } catch {}
}
`;

export interface NodeTestTrace {
  /** Environment for the command: NODE_OPTIONS extended with the probe. */
  env: Record<string, string>;
  /** Repository-relative paths of the files that started, or undefined when none did. */
  read(): string[] | undefined;
  dispose(): void;
}

export function traceNodeTestFiles(cwd: string, nodeOptions = process.env.NODE_OPTIONS): NodeTestTrace {
  const dir = mkdtempSync(join(tmpdir(), "diffci-node-test-trace-"));
  const probe = join(dir, "probe.cjs");
  const log = join(dir, "started.txt");
  writeFileSync(probe, PROBE);
  // NODE_OPTIONS reads a backslash inside double quotes as an escape; forward slashes work on Windows.
  const required = `--require "${probe.split(sep).join("/")}"`;
  const real = (path: string) => { try { return realpathSync.native(path); } catch { return path; } };
  return {
    env: { NODE_OPTIONS: nodeOptions?.trim() ? `${nodeOptions} ${required}` : required, DIFFCI_NODE_TEST_TRACE: log },
    read() {
      let lines: string[];
      try { lines = readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return undefined; }
      const root = real(cwd);
      const files = lines.map((file) => relative(root, real(file)).split(sep).join("/"));
      return files.length ? [...new Set(files)].sort() : undefined;
    },
    dispose() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Selected `node --test` files the trace does not show starting. Empty when the trace proves nothing. */
export function unstartedNodeTests(expected: readonly string[], started: readonly string[] | undefined, windows = process.platform === "win32"): string[] {
  if (!started?.length) return [];
  const key = (path: string) => windows ? path.toLowerCase() : path;
  const seen = new Set(started.map(key));
  return expected.filter((path) => !seen.has(key(path)));
}

/** The test count node:test's summary reports, or the test-file total vitest or jest reports. */
export function runnerTestCount(output: string): number | undefined {
  const node = [...output.matchAll(/^(?:ℹ|#) tests (\d+)\s*$/gm)];
  if (node.length) return node.reduce((sum, match) => sum + Number(match[1]), 0);
  const vitest = [...output.matchAll(/^\s*Test Files\s+.*\((\d+)\)\s*$/gm)];
  if (vitest.length) return vitest.reduce((sum, match) => sum + Number(match[1]), 0);
  const jest = [...output.matchAll(/^Test Suites:.*?(\d+) total\s*$/gm)];
  if (jest.length) return jest.reduce((sum, match) => sum + Number(match[1]), 0);
  return undefined;
}
