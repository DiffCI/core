import { commandArguments } from "./selected-coverage.js";
import { mergeTestFileResults } from "./test-results.js";
import { measureCommand, type CommandMeasurement } from "./verify-savings.js";

/**
 * Selected-test commands too long for the shell (2026-10-21).
 *
 * WHY. A selection is one runner invocation listing every selected test file. Windows runs it through
 * cmd.exe, whose command line stops at 8,191 characters: replaying a dogfood repository, every
 * selection of 191 files failed in under a second with exit 255 before any test ran, which a receipt
 * would report as a failed verification. Linux shells allow far more, so CI never saw it.
 *
 * WHAT. A command over the limit is split into several invocations of the same runner prefix, each
 * listing a share of the files, run one after another and reported as one verification. Splitting only
 * happens when the command ends in exactly the selected paths as plain tokens; anything else is left
 * whole, because rewriting a command that is not understood could change what it runs.
 */
export const COMMAND_LINE_LIMIT = process.platform === "win32" ? 8000 : 100_000;

/**
 * The runner prefix and the selected paths `command` ends with, one token each, or undefined when it does
 * not end in exactly selected paths. Every rewrite here (batching, reordering, splitting) needs this shape.
 */
function selectedTail(command: string, paths: readonly string[]): { prefix: string; tokens: Array<{ token: string; path: string }> } | undefined {
  const tokens = command.split(" ");
  const selected = new Set(paths);
  // A `node --test` path with brackets arrives quoted and class-escaped: "src/app/@([[])id@([]])/x.test.ts"
  // (Core before 2026-11-02 emitted the bare class, "src/app/[[]id[]]/x.test.ts").
  const pathOf = (token: string) => {
    if (selected.has(token)) return token;
    const decoded = (commandArguments(token)[0] ?? "").replace(/@\(\[(.)\]\)|\[(.)\]/g, (_, wrapped?: string, bare?: string) => wrapped ?? bare ?? "");
    return selected.has(decoded) ? decoded : undefined;
  };
  let start = tokens.length;
  while (start > 0 && pathOf(tokens[start - 1]!) !== undefined) start--;
  const trailing = tokens.slice(start);
  if (trailing.length === 0 || new Set(trailing).size !== trailing.length) return undefined;
  return { prefix: tokens.slice(0, start).join(" "), tokens: trailing.map((token) => ({ token, path: pathOf(token)! })) };
}

/**
 * `command` with its selected paths in `order` (test-ranking.ts, 2026-11-06), or unchanged when it does not
 * end in exactly the selected paths. Paths missing from `order` keep their place after the ordered ones.
 */
export function orderCommand(command: string, order: readonly string[]): string {
  const tail = selectedTail(command, order);
  if (!tail) return command;
  const rank = new Map(order.map((path, index) => [path, index]));
  const sorted = tail.tokens.map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => (rank.get(a.path) ?? order.length + a.index) - (rank.get(b.path) ?? order.length + b.index));
  return `${tail.prefix} ${sorted.map((entry) => entry.token).join(" ")}`;
}

/**
 * `command` as two invocations of the same runner, the `first` paths and then the rest, for `--fail-fast`;
 * `[command]` when it cannot be split safely or one side would be empty.
 */
export function splitCommand(command: string, paths: readonly string[], first: readonly string[]): string[] {
  const tail = selectedTail(command, paths);
  if (!tail) return [command];
  const head = new Set(first);
  const early = tail.tokens.filter((entry) => head.has(entry.path));
  const late = tail.tokens.filter((entry) => !head.has(entry.path));
  if (early.length === 0 || late.length === 0) return [command];
  return [early, late].map((part) => `${tail.prefix} ${part.map((entry) => entry.token).join(" ")}`);
}

/**
 * `command` keeping only the `keep` paths (`verify --shard`, test-shards.ts), `null` when it keeps none,
 * or undefined when `command` does not end in exactly selected paths and so cannot be cut safely.
 */
export function subsetCommand(command: string, paths: readonly string[], keep: ReadonlySet<string>): string | null | undefined {
  const tail = selectedTail(command, paths);
  if (!tail) return undefined;
  const kept = tail.tokens.filter((entry) => keep.has(entry.path));
  return kept.length ? `${tail.prefix} ${kept.map((entry) => entry.token).join(" ")}` : null;
}

/**
 * `command` with `extra` test files appended (coverage-map.ts), or undefined when `command` does not end in
 * exactly the selected paths or an extra path would need quoting, so it cannot be extended safely.
 */
export function appendToCommand(command: string, paths: readonly string[], extra: readonly string[]): string | undefined {
  if (!selectedTail(command, paths) || !extra.every((path) => /^[\w./@+-]+$/.test(path))) return undefined;
  return `${command} ${extra.join(" ")}`;
}

/** `command` split so each part fits `limit`, or `[command]` when it fits or cannot be split safely. */
export function batchCommand(command: string, paths: readonly string[], limit = COMMAND_LINE_LIMIT): string[] {
  if (command.length <= limit || paths.length === 0) return [command];
  const tail = selectedTail(command, paths);
  if (!tail) return [command];
  const { prefix } = tail;
  const trailing = tail.tokens.map((entry) => entry.token);
  if (prefix.length + 1 + Math.max(...trailing.map((t) => t.length)) > limit) return [command];
  const batches: string[][] = [[]];
  let length = prefix.length;
  for (const token of trailing) {
    const batch = batches[batches.length - 1]!;
    if (batch.length > 0 && length + 1 + token.length > limit) {
      batches.push([token]);
      length = prefix.length + 1 + token.length;
    } else {
      batch.push(token);
      length += 1 + token.length;
    }
  }
  return batches.map((batch) => `${prefix} ${batch.join(" ")}`);
}

/**
 * Runs `commands` in order as one verification. Every part runs, so one receipt carries every failing
 * test; the first non-zero exit is the result, and the remaining time budget is shared between parts.
 * With `stopOnFailure` (`--fail-fast`, 2026-11-06) the parts after the first failing one do not run.
 */
export function measureCommands(commands: readonly string[], options: { cwd: string; timeoutMs: number; tailBytes: number; env?: Record<string, string>; stopOnFailure?: boolean; stopOnFailureWithin?: number }): CommandMeasurement {
  if (commands.length === 1) return measureCommand(commands[0]!, options);
  const started = Date.now();
  const parts: CommandMeasurement[] = [];
  let stopped = false;
  for (const command of commands) {
    const remaining = options.timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    const part = measureCommand(command, { ...options, timeoutMs: remaining });
    parts.push(part);
    if (part.timedOut) break;
    // `stopOnFailureWithin`: only a failure among the first n parts stops the run (verify's first pass).
    const stops = options.stopOnFailure || parts.length <= (options.stopOnFailureWithin ?? 0);
    if (stops && (part.exitCode !== 0 || part.signal !== null) && parts.length < commands.length) { stopped = true; break; }
  }
  const failed = parts.find((part) => part.exitCode !== 0 || part.signal !== null || part.timedOut);
  const ranAll = parts.length === commands.length;
  const failingTests = [...new Set(parts.flatMap((part) => part.failingTests ?? []))].sort();
  const counted = ranAll && parts.every((part) => part.runnerTestCount !== undefined);
  const testResults = mergeTestFileResults(...parts.map((part) => part.testResults));
  const tail = (key: "stdoutTail" | "stderrTail") => parts.map((part) => part[key]).join("").slice(-Math.max(options.tailBytes, 0) || undefined);
  return {
    command: commands.join(" && "),
    exitCode: failed ? failed.exitCode : ranAll ? 0 : null,
    signal: failed?.signal ?? null,
    timedOut: parts.some((part) => part.timedOut) || (!ranAll && !stopped),
    startedAt: parts[0]?.startedAt ?? new Date(started).toISOString(),
    finishedAt: parts[parts.length - 1]?.finishedAt ?? new Date().toISOString(),
    wallMs: Date.now() - started,
    stdoutTail: options.tailBytes > 0 ? tail("stdoutTail") : "",
    stderrTail: options.tailBytes > 0 ? tail("stderrTail") : "",
    ...(failingTests.length ? { failingTests } : {}),
    ...(counted ? { runnerTestCount: parts.reduce((sum, part) => sum + part.runnerTestCount!, 0) } : {}),
    ...(testResults.length ? { testResults } : {}),
    ...(stopped ? { partsNotRun: commands.length - parts.length } : {}),
  };
}
