/**
 * The runner's OWN test universe — what the configured test runner can actually execute.
 *
 * WHY THIS EXISTS (defect 17, found 2026-08-31 closing M2 on the ts-jest mutation result).
 *
 * `test-discovery` answered "what looks like a test?" by scanning the tree for `.test.`/`.spec.`
 * files and UNIONING that with whatever globs a config declared. On `kulshekhar/ts-jest` that
 * reported a universe of 40 when jest executes 20: its `jest.config.ts` declares
 * `testMatch: ['<rootDir>/src/**\/*.spec.ts']`, but
 *
 *   1. `<rootDir>/` was never stripped, so the declared glob matched NOTHING - a repo-relative path
 *      never contains that token; and
 *   2. even had it matched, the conventional defaults were unioned on top, so 20 `e2e/` and
 *      `examples/` spec files that jest is configured never to touch stayed in the universe.
 *
 * On that repository the damage was confined to reporting, because none of the extra 20 was ever
 * selected. That was luck. A change under `e2e/` could have led DiffCI to select files the runner
 * ignores - selection that looks like coverage and detects nothing.
 *
 * THE SAFETY DIRECTION, which governs every decision in this file.
 *
 * Narrowing the modelled universe is the DANGEROUS direction. A test DiffCI cannot see is a test it
 * cannot select, and an unselected test that the runner would have run is exactly the shape of a
 * false green. Over-inclusion only wastes compute.
 *
 * So a declaration may replace the defaults ONLY when it was completely understood. The moment an
 * element is a spread, an unresolved identifier, an interpolated template or a call, `complete` goes
 * false and the caller keeps the old over-inclusive union. Half-understanding a config must never be
 * enough to hide a test.
 *
 * STATIC ONLY. Config files are repository code and are never imported or executed.
 */

/** Jest's repo-root token. */
const ROOT_DIR = "<rootDir>";

function stripRootDir(value: string): string {
  return value.startsWith(ROOT_DIR) ? value.slice(ROOT_DIR.length).replace(/^\//, "") : value;
}

export interface ExtractedTestPatterns {
  /** Declared test globs, `<rootDir>/` stripped. */
  includes: string[];
  /** Vitest `exclude` globs. */
  excludeGlobs: string[];
  /** Jest `testPathIgnorePatterns` — REGEX sources, not globs. */
  ignoreRegexSources: string[];
  /** Jest `roots`, repo-relative. Empty means no root restriction. */
  roots: string[];
  /** The config declared `include`/`testMatch` at all. If false it is relying on runner defaults. */
  declaresTests: boolean;
  /**
   * Every element of every declaration read was a plain string literal this scanner resolved.
   * ONLY a complete declaration may narrow the universe. See the safety note above.
   */
  complete: boolean;
}

/** Blanks comments so a commented-out glob is not lifted. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      if (end === -1) break;
      out += "\n";
      i = end + 1;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) break;
      out += " ".repeat(end + 2 - i);
      i = end + 2;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
      const quote = source[i]!;
      let j = i + 1;
      while (j < source.length && source[j] !== quote) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, Math.min(j + 1, source.length));
      i = j + 1;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

/**
 * Blanks `coverage: { ... }` blocks.
 *
 * Their `include` lists INSTRUMENTED SOURCE files, not tests. Lifting it would classify the whole
 * `src/` tree as tests.
 */
export function blankCoverageBlocks(source: string): string {
  let out = source;
  for (;;) {
    const m = /\bcoverage\s*:\s*\{/.exec(out);
    if (!m) return out;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) return out;
    out = out.slice(0, m.index) + " ".repeat(close + 1 - m.index) + out.slice(close + 1);
  }
}

/** A single-quoted, double-quoted or NON-interpolated template literal, and nothing else. */
const PLAIN_LITERAL = /^(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n$]*)`)$/;

/**
 * Lift the runner's declared universe out of a config file.
 *
 * Never throws, never executes. Unreadable input yields `complete: false`, which the caller must
 * treat as "keep the wide default universe".
 */
export function extractTestPatterns(source: string): ExtractedTestPatterns {
  const stripped = blankCoverageBlocks(stripComments(source));

  const arrayBodyAt = (open: number): string | undefined => {
    let depth = 0;
    for (let i = open; i < stripped.length; i++) {
      if (stripped[i] === "[") depth++;
      else if (stripped[i] === "]") {
        depth--;
        if (depth === 0) return stripped.slice(open + 1, i);
      }
    }
    return undefined;
  };

  // `const patterns = [ ... ]` so `include: patterns` can be resolved.
  const arrays = new Map<string, string>();
  for (const m of stripped.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[/g)) {
    const body = arrayBodyAt(m.index + m[0].length - 1);
    if (body !== undefined) arrays.set(m[1]!, body);
  }

  /** Split on TOP-LEVEL commas, so a nested call or array stays one element. */
  const elementsOf = (body: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "[" || ch === "(" || ch === "{") depth++;
      else if (ch === "]" || ch === ")" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        out.push(body.slice(start, i));
        start = i + 1;
      }
    }
    out.push(body.slice(start));
    return out.map((e) => e.trim()).filter((e) => e.length > 0);
  };

  let complete = true;

  const literalsOf = (body: string): string[] => {
    const out: string[] = [];
    for (const element of elementsOf(body)) {
      const m = PLAIN_LITERAL.exec(element);
      if (!m) {
        // A spread, an identifier, an interpolated template, a call. Not understood.
        complete = false;
        continue;
      }
      out.push(m[1] ?? m[2] ?? m[3] ?? "");
    }
    return out;
  };

  /** Returns undefined when the key is absent; [] when present but unreadable. */
  const readKey = (key: string): string[] | undefined => {
    let found: string[] | undefined;
    const re = new RegExp(`\\b${key}\\s*:\\s*(\\[|([A-Za-z_$][\\w$]*))`, "g");
    for (const m of stripped.matchAll(re)) {
      found ??= [];
      if (m[1] === "[") {
        const body = arrayBodyAt(m.index + m[0].length - 1);
        if (body === undefined) {
          complete = false;
          continue;
        }
        found.push(...literalsOf(body));
      } else if (m[2] !== undefined && arrays.has(m[2])) {
        found.push(...literalsOf(arrays.get(m[2])!));
      } else {
        complete = false;
      }
    }
    return found;
  };

  const rawInclude = readKey("include");
  const rawTestMatch = readKey("testMatch");
  const declaresTests = rawInclude !== undefined || rawTestMatch !== undefined;

  const includes: string[] = [];
  for (const raw of [...(rawInclude ?? []), ...(rawTestMatch ?? [])]) {
    // Negations and non-globs (env names and the like) are not part of the universe.
    if (raw.startsWith("!") || !/[*/]/.test(raw)) continue;
    const value = stripRootDir(raw);
    if (value.includes(ROOT_DIR)) {
      // `<rootDir>` somewhere other than the front - not resolvable without evaluating the config.
      complete = false;
      continue;
    }
    includes.push(value);
  }
  // A declaration that yielded no usable glob is a declaration we failed to read.
  if (declaresTests && includes.length === 0) complete = false;

  const roots = (readKey("roots") ?? [])
    .map(stripRootDir)
    .map((r) => r.replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((r) => r.length > 0 && !r.includes(ROOT_DIR));

  return {
    includes: Array.from(new Set(includes)),
    excludeGlobs: Array.from(new Set((readKey("exclude") ?? []).map(stripRootDir).filter((g) => /[*/]/.test(g) && !g.includes(ROOT_DIR)))),
    ignoreRegexSources: Array.from(new Set(readKey("testPathIgnorePatterns") ?? [])),
    roots,
    declaresTests,
    complete,
  };
}

/**
 * Compile jest `testPathIgnorePatterns` to regexes.
 *
 * They are regex sources matched against the test path, and jest matches them against the ABSOLUTE
 * path - which is why the default is `/node_modules/` with leading and trailing slashes. Repo-relative
 * paths are therefore tested with a leading "/" prepended, so the same sources mean the same thing.
 * An uncompilable source is DROPPED rather than thrown: an ignore we cannot read must not silently
 * become an ignore-everything.
 */
export function compileIgnoreRegexes(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const source of sources) {
    try {
      out.push(new RegExp(source));
    } catch {
      // Not a regex we can honour. Leaving it out keeps the universe WIDER, which is the safe side.
    }
  }
  return out;
}

/** True when `path` is ignored by any of `regexes`, using jest's absolute-path convention. */
export function isIgnoredPath(path: string, regexes: readonly RegExp[]): boolean {
  const absoluteish = path.startsWith("/") ? path : `/${path}`;
  return regexes.some((r) => r.test(absoluteish));
}

/** True when `path` lies under one of `roots`. An empty `roots` means no restriction. */
export function isUnderRoots(path: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => root === "" || root === "." || path === root || path.startsWith(`${root}/`));
}
