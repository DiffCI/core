import { matchesGlob } from "node:path";

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

/** The file patterns of each `node --test` invocation in `command` (directly, or through tsx). */
function nodeTestPatterns(command: string): string[][] {
  const invocations: string[][] = [];
  let segment: string[] = [];
  for (const arg of [...commandArguments(command), "&&"]) {
    if (arg !== "&&") { segment.push(arg); continue; }
    const testFlag = segment.indexOf("--test");
    if (testFlag > 0 && (segment[0] === "node" || segment.slice(0, testFlag).includes("tsx"))) {
      invocations.push(segment.slice(testFlag + 1).filter((value) => !value.startsWith("-")));
    }
    segment = [];
  }
  return invocations;
}

/** Selected files no `node --test` pattern in `command` matches. Empty when `command` runs no `node --test`. */
export function unmatchedNodeTests(command: string, selectedTests: readonly string[]): string[] {
  const patterns = nodeTestPatterns(command).flat();
  if (patterns.length === 0) return [];
  return selectedTests.filter((path) => !patterns.some((pattern) => matchesGlob(path, pattern)));
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
