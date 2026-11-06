import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { outcomeLogPath } from "./outcome-log.js";
import { measureCommand, type CommandMeasurement } from "./verify-savings.js";

/**
 * The coverage map (2026-11-06), the idea of Datadog Test Impact Analysis and pytest-testmon.
 *
 * WHY. The dependency graph sees imports. A test also reaches files it never imports: a fixture it reads
 * by name, a directory it lists, a module loaded through a computed specifier or a framework. Those edges
 * are the commonest reason a change runs the full suite, and the ones static analysis cannot find.
 *
 * WHAT. `diffci coverage` runs the full test command once with every `node --test` process (one per test
 * file) under a probe and V8 coverage. The probe records the files the test reads and the directories it
 * lists; V8 coverage records every module it loads, ESM included. The result, per test file, is kept in
 * `<git common dir>/diffci/coverage-map.json` beside the outcome log, never committed and never sent.
 *
 * Phase A, the only use so far: a verify run adds the tests whose map entry names a changed file and the
 * graph did not select. Adding a test is always safe, so a stale map costs time, never a miss. Replacing
 * a full-suite fallback with what the map says (phase B) waits until a replay shows it loses no catches.
 * Only node:test is supported: Vitest and Jest run many files in one worker, so reads cannot be told apart.
 */

export const COVERAGE_MAP_SCHEMA = "diffci.coverage-map.v1" as const;

export interface CoverageMap {
  schema: typeof COVERAGE_MAP_SCHEMA;
  produced_at: string;
  command: string;
  /** Repository-relative files each test file loaded or read, and directories (ending in `/`) it listed. */
  tests: Record<string, string[]>;
}

const PROBE = `"use strict";
if (process.env.NODE_TEST_CONTEXT && process.argv[1] && process.env.DIFFCI_COVERAGE_LOG) {
  const fs = require("node:fs");
  const { fileURLToPath } = require("node:url");
  const file = process.argv[1];
  const reads = new Set();
  const listed = new Set();
  const note = (set, target) => {
    try { set.add(typeof target === "string" ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : ""); } catch {}
  };
  const wrap = (owner, name, set) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    owner[name] = function (target, ...rest) { note(set, target); return original.call(this, target, ...rest); };
  };
  for (const name of ["readFileSync", "readFile", "createReadStream", "existsSync"]) wrap(fs, name, reads);
  for (const name of ["readdirSync", "readdir", "opendirSync", "opendir"]) wrap(fs, name, listed);
  wrap(fs.promises, "readFile", reads);
  wrap(fs.promises, "readdir", listed);
  wrap(fs.promises, "opendir", listed);
  try { require("node:module").syncBuiltinESMExports(); } catch {}
  process.on("exit", () => {
    try { fs.appendFileSync(process.env.DIFFCI_COVERAGE_LOG, JSON.stringify({ file, pid: process.pid, reads: [...reads], listed: [...listed] }) + "\\n"); } catch {}
  });
}
`;

interface ProbeRecord {
  file: string;
  pid: number;
  reads: string[];
  listed: string[];
}

export function coverageMapPath(repoPath: string): string | undefined {
  const log = outcomeLogPath(repoPath);
  return log ? join(log, "..", "coverage-map.json") : undefined;
}

export function readCoverageMap(repoPath: string): CoverageMap | undefined {
  const path = coverageMapPath(repoPath);
  if (!path || !existsSync(path)) return undefined;
  try {
    const map = JSON.parse(readFileSync(path, "utf8")) as CoverageMap;
    return map.schema === COVERAGE_MAP_SCHEMA && map.tests && typeof map.tests === "object" ? map : undefined;
  } catch {
    return undefined;
  }
}

export interface CoverageRun {
  map?: CoverageMap;
  path?: string;
  execution: CommandMeasurement;
  error?: string;
}

/** Runs `command` under the probe and V8 coverage, and writes the map. */
export function buildCoverageMap(repoPath: string, command: string, options: { timeoutMs: number; tailBytes?: number; nodeOptions?: string }): CoverageRun {
  const dir = mkdtempSync(join(tmpdir(), "diffci-coverage-"));
  try {
    const probe = join(dir, "probe.cjs");
    const log = join(dir, "reads.jsonl");
    const v8 = join(dir, "v8");
    mkdirSync(v8);
    writeFileSync(probe, PROBE);
    const nodeOptions = options.nodeOptions ?? process.env.NODE_OPTIONS;
    const required = `--require "${probe.split(sep).join("/")}"`;
    const execution = measureCommand(command, {
      cwd: repoPath,
      timeoutMs: options.timeoutMs,
      tailBytes: options.tailBytes ?? 4000,
      env: { NODE_OPTIONS: nodeOptions?.trim() ? `${nodeOptions} ${required}` : required, DIFFCI_COVERAGE_LOG: log, NODE_V8_COVERAGE: v8 },
    });
    let records: ProbeRecord[] = [];
    try { records = readFileSync(log, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as ProbeRecord]; } catch { return []; } }); } catch {}
    if (records.length === 0) {
      return { execution, error: "no node --test process reported to the probe; the coverage map needs node:test, which runs each test file in its own process" };
    }
    const root = realpath(repoPath);
    const inRepo = (absolute: string): string | undefined => {
      if (!absolute || !isAbsolute(absolute)) return undefined;
      const path = relative(root, realpath(absolute)).split(sep).join("/");
      if (!path || path.startsWith("..") || isAbsolute(path)) return undefined;
      if (path.split("/").some((part) => part === "node_modules" || part === ".git")) return undefined;
      return path;
    };
    const loaded = loadedModulesByPid(v8);
    const tests: Record<string, Set<string>> = {};
    for (const record of records) {
      const test = inRepo(record.file);
      if (!test) continue;
      const entry = tests[test] ??= new Set();
      for (const read of [...record.reads, ...(loaded.get(record.pid) ?? [])]) {
        const path = inRepo(read);
        if (path && path !== test && isFile(join(root, path))) entry.add(path);
      }
      for (const listed of record.listed) {
        const path = inRepo(listed);
        if (path && isDirectory(join(root, path))) entry.add(`${path}/`);
      }
    }
    const map: CoverageMap = {
      schema: COVERAGE_MAP_SCHEMA,
      produced_at: new Date().toISOString(),
      command,
      tests: Object.fromEntries(Object.entries(tests).sort(([a], [b]) => a.localeCompare(b)).map(([test, paths]) => [test, [...paths].sort()])),
    };
    const path = coverageMapPath(repoPath);
    if (path) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${JSON.stringify(map)}\n`, "utf8");
    }
    return { map, ...(path ? { path } : {}), execution };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Script URLs in each process's V8 coverage file (`coverage-<pid>-<time>-<n>.json`), by pid. */
function loadedModulesByPid(dir: string): Map<number, string[]> {
  const byPid = new Map<number, string[]>();
  for (const name of readdirSync(dir)) {
    const pid = Number(/^coverage-(\d+)-/.exec(name)?.[1]);
    if (!Number.isFinite(pid)) continue;
    try {
      const { result } = JSON.parse(readFileSync(join(dir, name), "utf8")) as { result: Array<{ url: string }> };
      const files = result.flatMap(({ url }) => { try { return url.startsWith("file:") ? [fileURLToPath(url)] : isAbsolute(url) ? [url] : []; } catch { return []; } });
      byPid.set(pid, [...(byPid.get(pid) ?? []), ...files]);
    } catch {}
  }
  return byPid;
}

function realpath(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}
function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Tests whose map entry names one of `changed` (or lists a directory holding one), that `selected` lacks. */
export function coverageAdditions(map: CoverageMap, changed: readonly string[], selected: readonly string[]): Array<{ test: string; changed_file: string }> {
  const have = new Set(selected);
  const additions: Array<{ test: string; changed_file: string }> = [];
  for (const [test, paths] of Object.entries(map.tests)) {
    if (have.has(test)) continue;
    const hit = changed.find((file) => paths.some((path) => path === file || (path.endsWith("/") && file.startsWith(path))));
    if (hit) additions.push({ test, changed_file: hit });
  }
  return additions;
}

export function formatCoverageRun(run: CoverageRun): string {
  if (!run.map) return `diffci coverage: ${run.error ?? "no map was built"}`;
  const tests = Object.keys(run.map.tests).length;
  const files = new Set(Object.values(run.map.tests).flat()).size;
  const lines = [`DiffCI coverage map: ${tests} test file(s), ${files} file(s) and directories they load, read or list`];
  if (run.path) lines.push(`  written to ${run.path} (inside .git, never committed or sent)`);
  if (run.execution.exitCode !== 0) lines.push(`  the test command exited ${String(run.execution.exitCode)}; the map still records what each test touched`);
  lines.push("  verify now adds tests this map connects to a changed file when the dependency graph did not select them");
  return lines.join("\n");
}
