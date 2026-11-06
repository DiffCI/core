import { readFileSync } from "node:fs";

import type { OutcomeRecord } from "./outcome-log.js";

/**
 * Splitting a selection across CI jobs (2026-11-06), the idea of Vitest's `--shard` and Knapsack Pro.
 *
 * WHY. A selection that still takes minutes runs faster split across a CI matrix, and the split is only
 * as good as its balance: shards of equal file count can differ in time by a factor of ten.
 *
 * WHAT. `verify --shard i/N` keeps shard i's share of the selected files. Every job of the matrix must
 * compute the same split without talking to the others, so the split depends only on the selection, which
 * is the same for the same commits, and on an explicit timings file (`--timings`, written by `diffci
 * outcomes --timings`) that every job reads the same copy of. The local outcome log is deliberately not
 * read: each CI job has its own, so jobs would disagree, and a file could run twice or never. Without a
 * timings file every file weighs the same. Files are assigned longest first to the shard with the least
 * time so far (ties to the lower shard), files of equal time in path order: deterministic everywhere.
 */

export interface ShardSpec {
  /** 1-based. */
  index: number;
  total: number;
}

export function parseShard(value: string): ShardSpec | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const index = Number(match[1]);
  const total = Number(match[2]);
  return index >= 1 && total >= 1 && index <= total && total <= 1000 ? { index, total } : undefined;
}

export const TIMINGS_SCHEMA = "diffci.timings.v1" as const;

export interface TimingsFile {
  schema: typeof TIMINGS_SCHEMA;
  /** Typical duration per test file, in milliseconds. */
  files: Record<string, number>;
}

/** The median of each file's last five recorded durations in the outcome log. */
export function timingsFromOutcomes(records: readonly OutcomeRecord[]): TimingsFile {
  const recent = new Map<string, number[]>();
  for (const record of records) {
    for (const result of record.test_results ?? []) {
      if (result.ms === undefined) continue;
      const list = recent.get(result.file) ?? [];
      list.push(result.ms);
      if (list.length > 5) list.shift();
      recent.set(result.file, list);
    }
  }
  const files: Record<string, number> = {};
  for (const [file, list] of [...recent].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...list].sort((a, b) => a - b);
    files[file] = sorted[Math.floor(sorted.length / 2)]!;
  }
  return { schema: TIMINGS_SCHEMA, files };
}

/** Reads a timings file, or throws with a message fit for the command line. */
export function readTimings(path: string): TimingsFile {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`could not read timings file ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const record = parsed as Partial<TimingsFile> | null;
  if (!record || record.schema !== TIMINGS_SCHEMA || !record.files || typeof record.files !== "object"
    || !Object.values(record.files).every((ms) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) {
    throw new Error(`timings file ${path} is not a ${TIMINGS_SCHEMA} file (write one with diffci outcomes --timings)`);
  }
  return record as TimingsFile;
}

/**
 * `tests` split into `total` shards of similar time. A file without a timing weighs the median known
 * timing, or 1 when none is known. Returns each shard's files in their given order.
 */
export function assignShards(tests: readonly string[], total: number, timings?: TimingsFile): string[][] {
  const known = tests.map((test) => timings?.files[test]).filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)]! : 1;
  const weighted = [...new Set(tests)].map((test) => ({ test, ms: timings?.files[test] ?? fallback }))
    .sort((a, b) => b.ms - a.ms || a.test.localeCompare(b.test));
  const loads = Array.from({ length: total }, () => 0);
  const members = Array.from({ length: total }, () => new Set<string>());
  for (const { test, ms } of weighted) {
    let target = 0;
    for (let shard = 1; shard < total; shard += 1) if (loads[shard]! < loads[target]!) target = shard;
    loads[target]! += ms;
    members[target]!.add(test);
  }
  return members.map((set) => tests.filter((test) => set.has(test)));
}
