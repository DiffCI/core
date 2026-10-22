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

/** `command` split so each part fits `limit`, or `[command]` when it fits or cannot be split safely. */
export function batchCommand(command: string, paths: readonly string[], limit = COMMAND_LINE_LIMIT): string[] {
  if (command.length <= limit || paths.length === 0) return [command];
  const tokens = command.split(" ");
  const selected = new Set(paths);
  let start = tokens.length;
  while (start > 0 && selected.has(tokens[start - 1]!)) start--;
  const trailing = tokens.slice(start);
  if (trailing.length === 0 || new Set(trailing).size !== trailing.length) return [command];
  const prefix = tokens.slice(0, start).join(" ");
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
 */
export function measureCommands(commands: readonly string[], options: { cwd: string; timeoutMs: number; tailBytes: number }): CommandMeasurement {
  if (commands.length === 1) return measureCommand(commands[0]!, options);
  const started = Date.now();
  const parts: CommandMeasurement[] = [];
  for (const command of commands) {
    const remaining = options.timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    const part = measureCommand(command, { ...options, timeoutMs: remaining });
    parts.push(part);
    if (part.timedOut) break;
  }
  const failed = parts.find((part) => part.exitCode !== 0 || part.signal !== null || part.timedOut);
  const ranAll = parts.length === commands.length;
  const failingTests = [...new Set(parts.flatMap((part) => part.failingTests ?? []))].sort();
  const tail = (key: "stdoutTail" | "stderrTail") => parts.map((part) => part[key]).join("").slice(-Math.max(options.tailBytes, 0) || undefined);
  return {
    command: commands.join(" && "),
    exitCode: failed ? failed.exitCode : ranAll ? 0 : null,
    signal: failed?.signal ?? null,
    timedOut: parts.some((part) => part.timedOut) || !ranAll,
    startedAt: parts[0]?.startedAt ?? new Date(started).toISOString(),
    finishedAt: parts[parts.length - 1]?.finishedAt ?? new Date().toISOString(),
    wallMs: Date.now() - started,
    stdoutTail: options.tailBytes > 0 ? tail("stdoutTail") : "",
    stderrTail: options.tailBytes > 0 ? tail("stderrTail") : "",
    ...(failingTests.length ? { failingTests } : {}),
  };
}
