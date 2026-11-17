// SPDX-License-Identifier: MIT
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice((match.index ?? 0) + match[0].length);
  const alternatives = match[1]!.split(",");
  const result: string[] = [];
  for (const alt of alternatives) result.push(...expandBraces(`${prefix}${alt}${suffix}`));
  return result;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;
const literal = (char: string): string => char.replace(REGEX_SPECIAL, "\\$&");

/**
 * Compiles one brace-free glob. `*` and `?` stay within a path segment, `**` crosses segments (a `**`
 * followed by a slash, or a trailing slash and `**`, also matches zero directories), `[...]`/`[!...]` is a character class, `\` escapes the
 * next character, and every other character is literal (#178: `(`, `+`, `|`, `$` and `^` used to reach
 * the RegExp as operators, and `+` threw).
 */
function regexFrom(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (pattern.startsWith("**/", i)) { source += "(?:.*/)?"; i += 2; continue; }
    if (pattern.startsWith("/**", i) && i + 3 === pattern.length) { source += "(?:/.*)?"; i += 2; continue; }
    if (pattern.startsWith("**", i)) { source += ".*"; i += 1; continue; }
    if (char === "*") { source += "[^/]*"; continue; }
    if (char === "?") { source += "[^/]"; continue; }
    if (char === "\\" && i + 1 < pattern.length) { source += literal(pattern[++i]!); continue; }
    if (char === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close > i) {
        let body = pattern.slice(i + 1, close);
        const negated = body.startsWith("!") || body.startsWith("^");
        if (negated) body = body.slice(1);
        source += `[${negated ? "^/" : ""}${body.replace(/[\\\]^[]/g, "\\$&")}]`;
        i = close;
        continue;
      }
    }
    source += literal(char);
  }
  return new RegExp(`^${source}$`);
}

function matches(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return expandBraces(pattern).some((p) => regexFrom(p).test(normalized));
}

export function matchesAny(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matches(path, p));
}
