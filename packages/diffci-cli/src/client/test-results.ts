/**
 * Per-test-file results (2026-11-06).
 *
 * WHY. The outcome log recorded one wall time and the failing test names per run. Ranking tests by
 * failure history, the confidence curve and splitting a selection into shards of equal time all need
 * each test file's own result and duration, from every run, starting now.
 *
 * WHAT. Vitest and Jest print one line per test file with its status and, usually, its duration; those
 * lines are read from the complete output. `node --test` prints test names, not files, so its files come
 * from the probe in selected-coverage.ts, which records each test process's file, duration and exit code.
 * Nothing changes how the command runs: no reporter is added, so a runner whose output is not recognised
 * simply yields no results.
 */

export interface TestFileResult {
  /** As the runner names it, usually relative to its root directory. */
  file: string;
  status: "passed" | "failed";
  ms?: number;
}

const ANSI = /\x1b\[[0-9;]*m/g;

function duration(value: string | undefined, unit: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return undefined;
  return Math.round(unit === "s" ? amount * 1000 : amount);
}

/**
 * Vitest: `✓ src/a.test.ts (3 tests) 12ms`, `❯ src/a.test.ts (3 tests | 1 failed) 1.2s`, optionally
 * with a `|project|` label. Only file lines carry the `(N test` count, which tells them from test lines.
 * Jest: `PASS src/a.test.ts`, `FAIL web src/a.test.ts (5.1 s)` (a project name may precede the path).
 */
export function parseTestFileResults(output: string): TestFileResult[] {
  const results = new Map<string, TestFileResult>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(ANSI, "");
    const vitest = /^\s*(✓|√|❯|×|✗)\s+(?:\|[^|]+\|\s+)?(\S+)\s+\((\d+) tests?(?:\s*\|[^)]*)?\)(?:\s+(\d+(?:\.\d+)?)(ms|s))?\s*$/.exec(line);
    if (vitest) {
      const failed = vitest[1] !== "✓" && vitest[1] !== "√" || /\|\s*\d+ failed/.test(line);
      const ms = duration(vitest[4], vitest[5]);
      results.set(vitest[2]!, { file: vitest[2]!, status: failed ? "failed" : "passed", ...(ms !== undefined ? { ms } : {}) });
      continue;
    }
    const jest = /^\s*(PASS|FAIL)\s+(?:\S+\s+)?(\S+\.[cm]?[jt]sx?)(?:\s+\((\d+(?:\.\d+)?) s\))?\s*$/.exec(line);
    if (jest) {
      const ms = duration(jest[3], "s");
      results.set(jest[2]!, { file: jest[2]!, status: jest[1] === "FAIL" ? "failed" : "passed", ...(ms !== undefined ? { ms } : {}) });
      continue;
    }
    // pytest progress: `tests/test_a.py ..F.  [ 50%]`; F or E marks a failure (2026-11-06).
    const pytest = /^(\S+\.py) ([.FEsxXp]+)\s*(?:\[\s*\d+%\])?\s*$/.exec(line);
    if (pytest) {
      const failed = /[FE]/.test(pytest[2]!) || results.get(pytest[1]!)?.status === "failed";
      results.set(pytest[1]!, { file: pytest[1]!, status: failed ? "failed" : "passed" });
    }
  }
  return [...results.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** One result per file; a later run of the same file (another command part) replaces an earlier one. */
export function mergeTestFileResults(...lists: ReadonlyArray<readonly TestFileResult[] | undefined>): TestFileResult[] {
  const merged = new Map<string, TestFileResult>();
  for (const list of lists) for (const result of list ?? []) merged.set(result.file, result);
  return [...merged.values()].sort((a, b) => a.file.localeCompare(b.file));
}
