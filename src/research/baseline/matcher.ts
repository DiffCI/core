// SPDX-License-Identifier: AGPL-3.0-only
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

function regexFrom(pattern: string): RegExp {
  let escaped = pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  // Protect the multi-segment globstar sequences behind placeholders before the
  // single-`*` replace runs below - otherwise the `*` inside "(?:.*/)?"/"(?:/.*)?" gets
  // re-matched and mangled by that same replace (e.g. "**/*.test.ts" would wrongly fail
  // to match files nested two or more directories deep).
  escaped = escaped
    .replace(/\*\*\//g, "\0GLOBSTAR_SLASH\0")
    .replace(/\/\*\*/g, "\0SLASH_GLOBSTAR\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0GLOBSTAR_SLASH\0/g, "(?:.*/)?")
    .replace(/\0SLASH_GLOBSTAR\0/g, "(?:/.*)?");
  return new RegExp(`^${escaped}$`);
}

function matches(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return expandBraces(pattern).some((p) => regexFrom(p).test(normalized));
}

export function matchesAny(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matches(path, p));
}
