// SPDX-License-Identifier: MIT
/**
 * Files a Jest or Vitest configuration runs around every test (2026-11-16, issue #139).
 *
 * `setupFiles`, `setupFilesAfterEnv`, `globalSetup` and their siblings are named only by the runner
 * configuration, never imported, so the dependency graph saw a changed setup file as source with no
 * dependents and selected no tests. A broken setup file fails the whole suite, so a change to one runs
 * every test.
 *
 * Each configuration's setup values are read statically: every string literal inside the value counts,
 * resolved against the configuration's directory (Jest's `<rootDir>` included), with or without an
 * extension. A setup key whose value holds no string literal at all (`setupFiles: files`) cannot be
 * read, and then any changed source file might be a setup file, so the caller falls back to the full suite.
 */
import { posix } from "node:path";
import ts from "typescript";

/** Configuration keys whose values are files the runner loads around every test. */
const SETUP_KEYS = new Set([
  "setupFiles", "setupFilesAfterEnv", "globalSetup", "globalTeardown", "testEnvironment",
  "snapshotSerializers", "snapshotResolver", "testSequencer", "testResultsProcessor", "reporters",
]);

const RUNNER_CONFIG = /^(?:jest\.config|vitest\.config|vite\.config|vitest\.workspace|vitest\.projects)\.(?:[cm]?[jt]s|json)$/;
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

export interface RunnerSetupFiles {
  /** Repo-relative setup file -> the configuration that names it. */
  readonly named: ReadonlyMap<string, string>;
  /** Configurations with a setup key DiffCI could not read. */
  readonly unreadable: readonly string[];
}

function isRunnerConfig(path: string): boolean {
  return !path.split("/").includes("node_modules") && RUNNER_CONFIG.test(posix.basename(path));
}

/** String literals inside one setup value, or `undefined` when there are none to read. */
function literalsIn(node: ts.Node): string[] | undefined {
  const values: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) values.push(child.text);
    // `path.join(__dirname, "test", "setup.ts")` and `resolve(...)`: the literal arguments joined are the path.
    if (ts.isCallExpression(child)) {
      const parts = child.arguments.filter((a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)).map((a) => (a as ts.StringLiteral).text);
      if (parts.length > 1) values.push(parts.join("/"));
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return values.length > 0 ? values : undefined;
}

/** Setup values of a JS/TS configuration; `undefined` marks one it could not read. */
function codeConfigValues(path: string, content: string): Array<string[] | undefined> {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: Array<string[] | undefined> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && SETUP_KEYS.has(node.name.text)) {
      found.push(literalsIn(node.initializer));
    } else if (ts.isShorthandPropertyAssignment(node) && SETUP_KEYS.has(node.name.text)) {
      found.push(undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Setup values of a JSON configuration or `package.json#jest`. */
function jsonConfigValues(value: unknown): string[][] {
  const found: string[][] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (SETUP_KEYS.has(key)) {
        const strings: string[] = [];
        const collect = (item: unknown): void => {
          if (typeof item === "string") strings.push(item);
          else if (Array.isArray(item)) item.forEach(collect);
          else if (item && typeof item === "object") Object.values(item).forEach(collect);
        };
        collect(child);
        found.push(strings);
      } else visit(child);
    }
  };
  visit(value);
  return found;
}

/** Repo-relative candidates a literal may name, relative to the configuration's directory. */
function candidatePaths(configDir: string, literal: string): string[] {
  const cleaned = literal.replace(/^<rootDir>\/?/, "").trim();
  if (!cleaned || cleaned.startsWith("/") || /^[a-z]+:/i.test(cleaned)) return [];
  const joined = posix.normalize(posix.join(configDir, cleaned));
  if (joined.startsWith("../") || joined === "..") return [];
  return [joined.replace(/^\.\//, "")];
}

/**
 * Setup files named by every runner configuration in `files` (repository paths at HEAD). `read` returns
 * a file's text, or `undefined` when it cannot be read.
 */
export function runnerSetupFiles(files: readonly string[], read: (path: string) => string | undefined): RunnerSetupFiles {
  const fileSet = new Set(files);
  const named = new Map<string, string>();
  const unreadable: string[] = [];
  const byStem = new Map<string, string[]>();
  for (const file of files) {
    if (!CODE_EXTENSION.test(file)) continue;
    const stem = file.replace(CODE_EXTENSION, "");
    byStem.set(stem, [...(byStem.get(stem) ?? []), file]);
    if (posix.basename(stem) === "index") {
      const dir = posix.dirname(stem);
      byStem.set(dir, [...(byStem.get(dir) ?? []), file]);
    }
  }
  const record = (config: string, literals: string[]) => {
    const configDir = posix.dirname(config) === "." ? "" : posix.dirname(config);
    for (const literal of literals) {
      for (const candidate of candidatePaths(configDir, literal)) {
        const matches = fileSet.has(candidate) ? [candidate] : byStem.get(candidate) ?? [];
        for (const match of matches) if (!named.has(match)) named.set(match, config);
      }
    }
  };
  for (const file of files) {
    const isManifest = posix.basename(file) === "package.json" && !file.split("/").includes("node_modules");
    if (!isManifest && !isRunnerConfig(file)) continue;
    const content = read(file);
    if (content === undefined) continue;
    if (isManifest || file.endsWith(".json")) {
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { continue; }
      const scope = isManifest ? (parsed as { jest?: unknown } | null)?.jest : parsed;
      for (const literals of jsonConfigValues(scope)) record(isManifest ? `${file}#jest` : file, literals);
      continue;
    }
    for (const literals of codeConfigValues(file, content)) {
      if (literals === undefined) { if (!unreadable.includes(file)) unreadable.push(file); continue; }
      record(file, literals);
    }
  }
  // Setup files often sit outside the dependency graph's source roots (`test/setup.ts`), so the modules
  // they import are followed here too: relative specifiers only, resolved like the graph resolves them.
  const queue = [...named.keys()];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const content = read(next);
    if (content === undefined) continue;
    for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(next), match[1]!));
      const stem = target.replace(/\.[cm]?js$/, "");
      const resolved = fileSet.has(target) ? [target] : byStem.get(stem) ?? [];
      for (const file of resolved) {
        if (named.has(file)) continue;
        named.set(file, named.get(next)!);
        queue.push(file);
      }
    }
  }
  return { named, unreadable: unreadable.sort() };
}
