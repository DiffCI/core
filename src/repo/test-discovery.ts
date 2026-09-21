/**
 * Test discovery from test-runner configuration (2026-08-23, deepseek-harness benchmark Phase 2).
 *
 * Before this module DiffCI recognised a test file purely by the `.test.` / `.spec.` filename
 * convention, hardcoded in three places (analyzer discovery, graph node flag, impact classification).
 * On deepseek-harness that silently left 22 `*.snapshot.ts` and 136 `*.e2e.ts` suites - each run by
 * its own `vitest run --config vitest.<family>.config.ts` CI job - outside the modelled test universe.
 *
 * This module reads the repository's OWN declaration of what a test is: the `include` globs of
 * Vitest/Jest configuration files at the repository root. It is deliberately STATIC - config files
 * are never imported or executed (they are repo code); string literals are lifted out of
 * `include: [ ... ]` arrays (and `testMatch` for Jest) by a tolerant scanner. Anything it cannot read
 * is simply not added, so the worst case is the pre-existing `.test.`/`.spec.` behaviour.
 *
 * Families are derived from the filename token between the last two dots (`foo.e2e.ts` -> e2e) -
 * a convention, not a deepseek-specific rule - and the config file name (`vitest.e2e.config.ts`).
 * Families matter downstream: a snapshot or e2e file is a real test that can be SELECTED, but it is
 * executed by a different command (and may need credentials/browsers), so execution validation must
 * treat families separately. Nothing here changes selection policy; it only widens what counts as a
 * test. Repositories with no such config, or whose configs only restate `.test.`/`.spec.`, are
 * unaffected.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { compileIgnoreRegexes, extractTestPatterns, isIgnoredPath, isUnderRoots } from "./runner-universe.js";
import { join } from "node:path";

export type TestFamily = "unit" | "snapshot" | "e2e" | "integration" | "benchmark";

export interface TestRunnerConfig {
  /** Repo-relative config file, e.g. "vitest.e2e.config.ts". */
  file: string;
  runner: "vitest" | "jest";
  /** String-literal include globs lifted from the config (no evaluation). */
  includes: string[];
  /** package.json script names that invoke this config (`--config <file>`), or the bare runner
   * for the default config. Execution validation uses these to find the real CI command. */
  scripts: string[];
  /** Family implied by the config's name token ("vitest.e2e.config.ts" -> e2e); undefined for the
   * default config, whose files are classified individually by filename token. */
  family?: TestFamily;
  /** Vitest `exclude` globs declared by this config. */
  excludeGlobs: string[];
  /** Jest `testPathIgnorePatterns` - regex sources, not globs. */
  ignoreRegexSources: string[];
  /** Jest `roots`, repo-relative; empty means no restriction. */
  roots: string[];
  /** This config declared its own test globs at all. If false it relies on its runner defaults. */
  declaresTests: boolean;
  /** The runner DEFAULT config (`jest.config.ts`), not a named variant (`vitest.e2e.config.ts`). */
  isDefault: boolean;
  /**
   * The declaration was COMPLETELY understood, so it may replace DiffCI conventional defaults.
   *
   * See the safety note in `runner-universe.ts`: narrowing on a half-read config could hide a test
   * the runner really executes, and a test DiffCI cannot see is a test it cannot select.
   */
  authoritative: boolean;
}

export interface TestDiscovery {
  configs: TestRunnerConfig[];
  /**
   * The effective test universe: every config include, deduplicated, PLUS DEFAULT_TEST_PATTERNS
   * unless every discovered config declared its own globs and was fully understood - in which case
   * the repository has stated exactly what its runner executes (defect 17).
   */
  patterns: string[];
  /**
   * The defaults were dropped in favour of the repository own declaration.
   *
   * A caller that adds framework default includes on top MUST honour this, or it re-widens the
   * universe that was just narrowed and the fix does nothing.
   */
  replacedDefaults: boolean;
  excludeGlobs: string[];
  ignoreRegexSources: string[];
  roots: string[];
}

export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
];

const FAMILY_TOKENS: Record<string, TestFamily> = {
  test: "unit", spec: "unit", unit: "unit",
  snapshot: "snapshot", snap: "snapshot",
  e2e: "e2e",
  integration: "integration", int: "integration", it: "integration",
  bench: "benchmark", benchmark: "benchmark", perf: "benchmark",
};

/** Family of a test file from its filename token: `name.<token>.<ext>`. Undefined when the file has
 * no recognised token (then it is only a test if a config include says so; treated as "unit"). */
export function testFamilyOfPath(filePath: string): TestFamily | undefined {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const parts = base.split(".");
  if (parts.length < 3) return undefined;
  const token = parts[parts.length - 2]!.toLowerCase();
  return FAMILY_TOKENS[token];
}

function familyOfConfigName(file: string): TestFamily | undefined {
  // vitest.<token>.config.ts / jest.<token>.config.js -> token; plain vitest.config.ts -> undefined
  const m = /^(?:vitest|jest)\.([a-z0-9-]+)\.config\./i.exec(file);
  if (!m) return undefined;
  const token = m[1]!.toLowerCase();
  if (token in FAMILY_TOKENS) return FAMILY_TOKENS[token];
  if (token.includes("e2e")) return "e2e";
  if (token.includes("snapshot")) return "snapshot";
  if (token.includes("integration")) return "integration";
  return undefined; // e.g. "web", "web-stress": family comes from each file's token instead
}

const CONFIG_NAME = /^(vitest|jest)(\.[a-z0-9-]+)?\.config\.(ts|mts|cts|js|mjs|cjs)$/i;

/**
 * Lift string literals out of `include: [ ... ]` / `testMatch: [ ... ]` arrays. Tolerates spreads,
 * comments and conditional entries inside the array (their literals are lifted too - over-inclusion
 * only makes MORE files count as tests, never fewer). Also follows one level of indirection:
 * `include: someIdent` where `const someIdent = [ ... ]` is declared in the same file.
 */
/** Removes JS comments while leaving string literals untouched - a naive regex would eat the `/**\/`
 * inside a glob like `tests/**\/*.spec.ts`. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && next !== undefined) { out += next; i += 2; continue; }
      if (ch === quote) quote = undefined;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { const end = source.indexOf("*/", i + 2); i = end === -1 ? source.length : end + 2; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** Blanks `coverage: { ... }` blocks: their `include` lists INSTRUMENTED SOURCE files, not tests, and
 * lifting them would mark every source file as a test (observed on deepseek-harness: +1,382 files). */
export function blankCoverageBlocks(source: string): string {
  let out = source;
  for (let guard = 0; guard < 32; guard++) {
    const m = /\bcoverage\s*:\s*\{/.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close === -1) break;
    out = out.slice(0, m.index) + " ".repeat(close + 1 - m.index) + out.slice(close + 1);
  }
  return out;
}

export function extractIncludeGlobs(source: string): string[] {
  const stripped = blankCoverageBlocks(stripComments(source));
  // Bracket-depth aware: returns the body of the array literal opening at `open` (index of "[").
  const arrayBodyAt = (open: number): string | undefined => {
    let depth = 0;
    for (let i = open; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) return stripped.slice(open + 1, i); }
    }
    return undefined;
  };
  const arrays = new Map<string, string>();
  for (const m of stripped.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[/g)) {
    const body = arrayBodyAt(m.index + m[0].length - 1);
    if (body !== undefined) arrays.set(m[1]!, body);
  }
  const globs: string[] = [];
  const lift = (body: string) => { for (const s of body.matchAll(/['"`]([^'"`\n]+)['"`]/g)) globs.push(s[1]!); };
  for (const m of stripped.matchAll(/\b(?:include|testMatch)\s*:\s*(\[|([A-Za-z_$][\w$]*))/g)) {
    if (m[1] === "[") { const body = arrayBodyAt(m.index + m[0].length - 1); if (body !== undefined) lift(body); }
    else if (m[2] && arrays.has(m[2])) lift(arrays.get(m[2])!);
  }
  // Only keep things that look like file globs (contain a slash or a glob char) - drops e.g. env names
  return Array.from(new Set(globs.filter((g) => /[*/]/.test(g) && !g.startsWith("!"))));
}

function scriptsInvoking(scripts: Record<string, string>, runner: "vitest" | "jest", configFile: string, isDefault: boolean): string[] {
  const result: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!new RegExp(`\\b${runner}\\b`).test(cmd)) continue;
    const cfg = /--config(?:=|\s+)(\S+)/.exec(cmd)?.[1];
    if (cfg ? cfg === configFile || cfg.endsWith(`/${configFile}`) : isDefault) result.push(name);
  }
  return result.sort();
}

/** Static discovery of test-runner configs at the repository root. Never throws; never executes. */
export function discoverTestRunnerConfigs(repoPath: string, scripts: Record<string, string> = {}): TestDiscovery {
  const configs: TestRunnerConfig[] = [];
  let entries: string[] = [];
  try { entries = existsSync(repoPath) ? readdirSync(repoPath) : []; } catch { entries = []; }
  for (const name of entries.sort()) {
    const m = CONFIG_NAME.exec(name);
    if (!m) continue;
    const full = join(repoPath, name);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    let source = "";
    try { source = readFileSync(full, "utf8"); } catch { continue; }
    const runner = m[1]!.toLowerCase() as "vitest" | "jest";
    const isDefault = m[2] === undefined;
    const extracted = extractTestPatterns(source);
    configs.push({
      file: name,
      runner,
      includes: extracted.includes,
      scripts: scriptsInvoking(scripts, runner, name, isDefault),
      family: familyOfConfigName(name),
      excludeGlobs: extracted.excludeGlobs,
      ignoreRegexSources: extracted.ignoreRegexSources,
      roots: extracted.roots,
      declaresTests: extracted.declaresTests,
      isDefault,
      authoritative: extracted.declaresTests && extracted.complete && extracted.includes.length > 0,
    });
  }

  // THE REPLACEMENT RULE, and it is deliberately narrow.
  //
  // Only the DEFAULT config (`jest.config.ts`, `vitest.config.ts`) describes what the bare runner
  // executes, so only the default config may replace the runner built-in globs. A named variant
  // (`vitest.e2e.config.ts`) is a SEPARATE job: it ADDS its includes and says nothing about what
  // plain `vitest` runs. Treating a variant as authority over the default universe would drop every
  // `*.spec.ts` in a repository whose only config file happens to be an e2e one - narrowing on
  // evidence that does not bear on the question.
  //
  // And the default config must have been COMPLETELY understood. Wrong-wide costs compute;
  // wrong-narrow can hide a test the runner executes, which is the shape of a false green. Every
  // ambiguity resolves wide.
  const defaults = configs.filter((c) => c.isDefault);
  const replacedDefaults = defaults.length > 0 && defaults.every((c) => c.authoritative);

  const patterns = new Set<string>(replacedDefaults ? [] : DEFAULT_TEST_PATTERNS);
  for (const c of configs) for (const g of c.includes) patterns.add(g);

  // Excludes, ignores and roots are NARROWING, so they are honoured only from configs whose
  // declaration was fully understood - and only when the declaration is actually in force.
  // Narrowing metadata is honoured ONLY from an authoritative DEFAULT config. A variant roots or
  // ignore list governs that variant own job, and applying it repository-wide would over-narrow.
  const authoritative = replacedDefaults ? defaults : [];
  return {
    configs,
    patterns: Array.from(patterns),
    replacedDefaults,
    excludeGlobs: Array.from(new Set(authoritative.flatMap((c) => c.excludeGlobs))),
    ignoreRegexSources: Array.from(new Set(authoritative.flatMap((c) => c.ignoreRegexSources))),
    roots: Array.from(new Set(authoritative.flatMap((c) => c.roots))),
  };
}

// --- glob matching (shared by analyzer / graph / impact so "is this a test?" has ONE answer) ---

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  const out: string[] = [];
  for (const alt of match[1]!.split(",")) out.push(...expandBraces(`${prefix}${alt}${suffix}`));
  return out;
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extended-glob groups - `?(a|b)`, `*(a|b)`, `+(a|b)`, `@(a|b)` - are not exotic: they appear in the
 * published default include globs of both vitest (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) and jest, and
 * in every config that copies them. Passed through to `RegExp` unchanged, `?(x)` reads as "an
 * optional preceding character, then a literal x", so `__tests__/base.js` matched nothing at all.
 * Measured cost before this fix (Phase 01 baseline, 2026-08-26): immerjs/immer discovered ZERO test
 * files from its own explicit `include: ["**\/__tests__\/**\/*.[jt]s?(x)"]`, while still classifying
 * 5 of 5 commits SELECTIVE at COMPLETE confidence.
 *
 * `!(...)` (negation) is deliberately not modelled - it needs real parsing to be correct. It is
 * widened to "any single path segment", which OVER-includes. Over-inclusion counts extra files as
 * tests; under-inclusion silently empties the test universe. The former is the safe direction.
 *
 * A bare `?` outside a group is a single-character wildcard (`[^/]`), which it also was not: it
 * previously reached the regex as a quantifier over whatever preceded it.
 */
/**
 * Wildcards inside an extglob body, translated by the same rules as the rest of the pattern.
 *
 * `?(*.)` in jest's `**\/?(*.)+(spec|test).[jt]s?(x)` means "optionally: anything, then a dot". The
 * body is a glob in its own right, so escaping it as a literal turns it into "optionally the two
 * characters `*` and `.`" - which no real path contains, so `src/foo.test.js` matched NOTHING while
 * the bare `test.js` still matched. Found 2026-08-30 while diagnosing Prettier, where it was one of
 * two defects in the same area (see the duplicate matcher deleted from impact.ts).
 *
 * Bracket expressions such as `[jt]` are left alone deliberately: they are already valid regex
 * character classes and mean the same thing in both syntaxes.
 */
function translateExtglobBody(body: string): string {
  return body.replace(/\\/g, "\\\\").replace(/\./g, "\\.").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
}

function globToRegex(pattern: string): RegExp {
  // Extglob bodies contain `*`, `?` and `|` that must not be rewritten by the wildcard rules below,
  // so they are lifted out behind placeholders first and restored last.
  const groups: string[] = [];
  let working = pattern.replace(/([?*+@!])\(([^()]*)\)/g, (_match, operator: string, body: string) => {
    const alternatives = body.split("|").map(translateExtglobBody).join("|");
    const source =
      operator === "!"
        ? "[^/]*"
        : `(?:${alternatives})${operator === "?" ? "?" : operator === "*" ? "*" : operator === "+" ? "+" : ""}`;
    groups.push(source);
    return `\0X${groups.length - 1}\0`;
  });

  working = working.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  working = working
    .replace(/\*\*\//g, "\0GS\0")
    .replace(/\/\*\*/g, "\0SG\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0GS\0/g, "(?:.*/)?")
    .replace(/\0SG\0/g, "(?:/.*)?");
  working = working.replace(/\0X(\d+)\0/g, (_match, index: string) => groups[Number(index)]!);
  return new RegExp(`^${working}$`);
}

/** Matches a repo-relative posix path against one glob, with brace and extglob support. Exported so
 * analyzer discovery, graph node flags and impact classification all share ONE definition of a
 * match rather than the two near-identical copies that existed before Phase 01. */
export function matchesGlob(path: string, pattern: string): boolean {
  return expandBraces(pattern).some((p) => globToRegex(p).test(path));
}

export interface TestFileMatcher {
  (repoRelativePath: string): boolean;
  readonly patterns: readonly string[];
}

export interface TestFileMatcherOptions {
  /** Globs that disqualify a file, from the declared frameworks' own default excludes. */
  excludePatterns?: readonly string[];
  /** Globs whose match wins over any exclude - DiffCI's conventional patterns and anything the
   * repository declared explicitly in its own config. A repository that names a file a test has
   * settled the question; only files pulled in by a framework's DEFAULT includes are subject to
   * that framework's default excludes (Phase 01, 2026-08-26). */
  authoritativePatterns?: readonly string[];
  /** Jest `testPathIgnorePatterns`, compiled. A match disqualifies the file outright - the runner
   * would not execute it, so DiffCI must not model it as executable (defect 17). */
  ignoreRegexes?: readonly RegExp[];
  /** Jest `roots`. A file outside every root is outside the runner universe. Empty = no limit. */
  roots?: readonly string[];
}

function compile(patterns: readonly string[]): RegExp[] {
  return patterns.flatMap((p) => expandBraces(p.includes("/") ? p : `**/${p}`)).map(globToRegex);
}

/** Builds a matcher over repo-relative posix paths. Patterns without a slash (bare filename globs)
 * are treated as `**\/<pattern>` so a config's `*.spec.ts` still means "anywhere". */
export function createTestFileMatcher(
  patterns: readonly string[],
  options: TestFileMatcherOptions = {},
): TestFileMatcher {
  const regexes = compile(patterns);
  const excludes = compile(options.excludePatterns ?? []);
  const authoritative = compile(options.authoritativePatterns ?? []);
  const ignoreRegexes = options.ignoreRegexes ?? [];
  const roots = options.roots ?? [];
  const fn = ((path: string) => {
    // Runner-universe vetoes come FIRST, ahead of even the authoritative patterns. A file the
    // configured runner will not execute is not a test DiffCI can select, however strongly
    // DiffCI conventions or the repository own include globs say it looks like one.
    if (!isUnderRoots(path, roots)) return false;
    if (isIgnoredPath(path, ignoreRegexes)) return false;
    if (authoritative.some((r) => r.test(path))) return true;
    if (excludes.some((r) => r.test(path))) return false;
    return regexes.some((r) => r.test(path));
  }) as TestFileMatcher;
  Object.defineProperty(fn, "patterns", { value: Object.freeze([...patterns]) });
  return fn;
}

/** The one place that turns a profile into a matcher, so analyzer discovery, graph node flags and
 * impact classification cannot disagree about what a test is. */
export function testFileMatcherForProfile(profile: {
  goTestPackages?: Record<string, string>;
  testPatterns?: readonly string[];
  testExcludePatterns?: readonly string[];
  testAuthoritativePatterns?: readonly string[];
  testIgnoreRegexSources?: readonly string[];
  testRoots?: readonly string[];
}): TestFileMatcher {
  if (profile.goTestPackages && Object.keys(profile.goTestPackages).length) {
    const jsMatcher = testFileMatcherForProfile({ ...profile, goTestPackages: undefined });
    const matcher = ((path: string) => Object.hasOwn(profile.goTestPackages!, path) || jsMatcher(path)) as TestFileMatcher;
    Object.defineProperty(matcher, "patterns", { value: jsMatcher.patterns });
    return matcher;
  }
  if (!profile.testPatterns) return DEFAULT_TEST_FILE_MATCHER;
  return createTestFileMatcher(profile.testPatterns, {
    excludePatterns: profile.testExcludePatterns,
    authoritativePatterns: profile.testAuthoritativePatterns,
    ignoreRegexes: compileIgnoreRegexes(profile.testIgnoreRegexSources ?? []),
    roots: profile.testRoots,
  });
}

/** The pre-2026-08-23 behaviour, kept as the fallback when no profile is available. */
export const DEFAULT_TEST_FILE_MATCHER: TestFileMatcher = createTestFileMatcher(DEFAULT_TEST_PATTERNS);
