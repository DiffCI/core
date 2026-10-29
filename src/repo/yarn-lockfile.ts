// SPDX-License-Identifier: MIT
/**
 * Conservative dependency candidates for Yarn Classic v1 lockfile changes.
 *
 * Unlike npm's installed-path lockfile, Classic records request selectors and omits peer dependency
 * relationships and the hoisted install layout. Traversing dependencies alone therefore cannot prove
 * that another direct package is unaffected. A semantic change returns ALL old/new direct names,
 * after validating exact manifest requests and attributing every changed selector to a root. The
 * caller must still account for tooling, lockfile readers and undeclared imports of hoisted packages.
 * This is a candidate set for conservative selection, not an exact list of changed installed trees.
 *
 * Only generated v1 registry entries with version/resolved/integrity and dependency mappings are
 * modeled. Berry, workspaces/aliases/local or git requests, missing edges, ambiguous or malformed
 * syntax and unfamiliar fields return undefined so the caller retains full validation. This small
 * parser intentionally accepts less than Yarn's general parser; it never repairs merge conflicts.
 */

type DirectDependencies = Readonly<Record<string, string>>;

interface LockEntry {
  version: string;
  resolved: string;
  integrity?: string;
  dependencies: Map<string, string>;
  optionalDependencies: Map<string, string>;
}

interface Token { value: string; end: number }

// Keep parsing bounded independently of the repository's Git output limit. Bigger lockfiles fall
// back; these are coverage limits, not a reason to interpret a prefix as a complete lockfile.
const MAX_CONTENT_LENGTH = 8 * 1024 * 1024;
const MAX_LINES = 100_000;
const MAX_LINE_LENGTH = 16_384;
const MAX_SELECTORS = 100_000;
const PACKAGE_NAME = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const NUMERIC_PART = "(?:0|[1-9][0-9]*)";
const IDENTIFIERS = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const EXACT_VERSION = new RegExp(`^${NUMERIC_PART}\\.${NUMERIC_PART}\\.${NUMERIC_PART}(?:-${IDENTIFIERS})?(?:\\+${IDENTIFIERS})?$`);
const RANGE_VERSION = new RegExp(`^v?(?:${NUMERIC_PART}|[xX*])(?:\\.(?:${NUMERIC_PART}|[xX*])){0,2}$`);

function isExactVersion(value: string): boolean {
  if (!EXACT_VERSION.test(value)) return false;
  const prerelease = /^[^-]+-([^+]+)/.exec(value)?.[1];
  return !prerelease || prerelease.split(".").every((part) => !/^0[0-9]+$/.test(part));
}

function isRangeVersion(value: string): boolean {
  const version = value.replace(/^v/, "");
  if (isExactVersion(version)) return true;
  if (!RANGE_VERSION.test(value)) return false;
  // Once a wildcard is used, a later numeric component is not a modeled range (e.g. 1.x.3).
  const parts = version.split(".");
  const wildcard = parts.findIndex((part) => /^[xX*]$/.test(part));
  return wildcard === -1 || parts.slice(wildcard).every((part) => /^[xX*]$/.test(part));
}

/** A deliberately limited registry semver grammar; tags and protocol requests remain unsupported. */
function isRegistryRequest(value: string): boolean {
  if (!value || value.length > 512 || value !== value.trim()) return false;
  return value.split("||").every((alternative) => {
    const range = alternative.trim();
    if (!range) return false;
    const hyphen = range.split(" - ");
    if (hyphen.length > 1) return hyphen.length === 2 && hyphen.every(isRangeVersion);
    // Yarn also accepts spaces after comparators. Normalizing them here only validates syntax;
    // selector lookup below still uses the exact original request from the manifest or entry.
    const comparators = range.replace(/([<>]=?|[=~^]) +/g, "$1").split(/ +/);
    return comparators.every((part) => {
      const match = /^(?:<=|>=|<|>|=|~|\^)?(.+)$/.exec(part);
      return !!match && isRangeVersion(match[1]!);
    });
  });
}

function descriptor(name: string, request: string): string | undefined {
  return PACKAGE_NAME.test(name) && isRegistryRequest(request) ? `${name}@${request}` : undefined;
}

function validSelector(selector: string): boolean {
  const separator = selector.indexOf("@", selector.startsWith("@") ? 1 : 0);
  return separator > 0 && descriptor(selector.slice(0, separator), selector.slice(separator + 1)) === selector;
}

/** Read a JSON-quoted string or a Classic bare string, without interpreting comments as content. */
function tokenAt(text: string, start: number): Token | undefined {
  if (text[start] === '"') {
    let end = start + 1;
    for (; end < text.length; end++) {
      if (text[end] === "\\") { end++; continue; }
      if (text[end] !== '"') continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
        return { value, end: end + 1 };
      } catch { return undefined; }
    }
    return undefined;
  }
  const match = /^[a-zA-Z/.-][^\s:,"\\\[\]{}]*/.exec(text.slice(start));
  return match ? { value: match[0], end: start + match[0].length } : undefined;
}

function selectorHeader(line: string): string[] | undefined {
  const selectors: string[] = [];
  const seen = new Set<string>();
  let packageName: string | undefined;
  let position = 0;
  while (position < line.length) {
    const token = tokenAt(line, position);
    if (!token || !validSelector(token.value) || seen.has(token.value)) return undefined;
    const separator = token.value.indexOf("@", token.value.startsWith("@") ? 1 : 0);
    const name = token.value.slice(0, separator);
    if (packageName !== undefined && packageName !== name) return undefined;
    packageName = name;
    selectors.push(token.value);
    seen.add(token.value);
    position = token.end;
    while (line[position] === " ") position++;
    if (line[position] === ":") return line.slice(position + 1).trim() === "" ? selectors : undefined;
    if (line[position] !== ",") return undefined;
    position++;
    while (line[position] === " ") position++;
  }
  return undefined;
}

function pair(line: string): [string, string] | undefined {
  const key = tokenAt(line, 0);
  if (!key || line[key.end] !== " ") return undefined;
  let position = key.end;
  while (line[position] === " ") position++;
  const value = tokenAt(line, position);
  if (!value || line.slice(value.end).trim() !== "") return undefined;
  return [key.value, value.value];
}

function registryResolution(value: string, integrity: string | undefined): boolean {
  if (!/^https?:\/\/[^\s\\]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return false;
    // Registry URLs need not use a particular host or filename. Require a content pin, though:
    // Classic's resolved fragment is SHA1; newer files can instead carry an integrity digest.
    if (url.hash && !/^#[a-fA-F0-9]{40}$/.test(url.hash)) return false;
    return !!url.hash || integrity !== undefined;
  } catch { return false; }
}

function validIntegrity(value: string): boolean {
  const sizes: Record<string, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  return value.split(" ").every((token) => {
    const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) return false;
    const digest = Buffer.from(match[2]!, "base64");
    return digest.length === sizes[match[1]!] && digest.toString("base64").replace(/=+$/, "") === match[2]!.replace(/=+$/, "");
  });
}

function parse(content: string | undefined): Map<string, LockEntry> | undefined {
  if (content === undefined || content.length > MAX_CONTENT_LENGTH) return undefined;
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) return undefined;
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) return undefined;
  const entries = new Map<string, LockEntry>();
  let hasHeader = false;
  let selectors: string[] = [];
  let entry: LockEntry | undefined;
  let fields = new Set<string>();
  let section: "dependencies" | "optionalDependencies" | undefined;

  const finish = (): boolean => {
    if (!entry) return true;
    if (!isExactVersion(entry.version) || !registryResolution(entry.resolved, entry.integrity)) return false;
    for (const selector of selectors) {
      if (entries.has(selector) || entries.size >= MAX_SELECTORS) return false;
      entries.set(selector, entry);
    }
    return true;
  };

  for (const rawLine of lines) {
    if (rawLine.length > MAX_LINE_LENGTH) return undefined;
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (/^#\s*yarn lockfile\b/.test(line)) {
        if (line !== "# yarn lockfile v1" || hasHeader || entry) return undefined;
        hasHeader = true;
      }
      continue;
    }
    if (!hasHeader) return undefined;
    const indentation = line.length - line.trimStart().length;
    if (indentation === 0) {
      if (!finish()) return undefined;
      const parsed = selectorHeader(line);
      if (!parsed) return undefined;
      selectors = parsed;
      entry = { version: "", resolved: "", dependencies: new Map(), optionalDependencies: new Map() };
      fields = new Set();
      section = undefined;
      continue;
    }
    if (!entry) return undefined;
    if (indentation === 2) {
      const body = line.slice(2);
      const key = tokenAt(body, 0);
      if (!key || fields.has(key.value)) return undefined;
      fields.add(key.value);
      section = undefined;
      if (key.value === "dependencies" || key.value === "optionalDependencies") {
        if (body.slice(key.end) !== ":") return undefined;
        section = key.value;
        continue;
      }
      const scalar = pair(body);
      if (!scalar) return undefined;
      if (scalar[0] === "version" || scalar[0] === "resolved") entry[scalar[0]] = scalar[1];
      else if (scalar[0] === "integrity") {
        if (!validIntegrity(scalar[1])) return undefined;
        entry.integrity = scalar[1].split(" ").sort().join(" ");
      } else return undefined;
    } else if (indentation === 4 && section) {
      const dependency = pair(line.slice(4));
      if (!dependency || !descriptor(...dependency)) return undefined;
      const [name, request] = dependency;
      if (entry.dependencies.has(name) || entry.optionalDependencies.has(name)) return undefined;
      entry[section].set(name, request);
    } else return undefined;
  }
  if (!hasHeader || !finish()) return undefined;
  // Even an unchanged or unreachable entry with missing dependency data makes the model incomplete.
  for (const entry of new Set(entries.values())) {
    for (const [name, request] of [...entry.dependencies, ...entry.optionalDependencies]) {
      if (!entries.has(`${name}@${request}`)) return undefined;
    }
  }
  return entries;
}

function roots(entries: Map<string, LockEntry>, direct: DirectDependencies): string[] | undefined {
  if (!direct || typeof direct !== "object" || Array.isArray(direct)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(direct);
  if (prototype !== null && prototype !== Object.prototype) return undefined;
  const result: string[] = [];
  for (const [name, request] of Object.entries(direct)) {
    if (typeof request !== "string") return undefined;
    const selector = descriptor(name, request);
    if (!selector || !entries.has(selector)) return undefined;
    result.push(selector);
  }
  return result;
}

function reachable(entries: Map<string, LockEntry>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const expanded = new Set<LockEntry>();
  const queue = [...roots];
  while (queue.length) {
    const selector = queue.pop()!;
    if (seen.has(selector)) continue;
    seen.add(selector);
    const entry = entries.get(selector)!; // roots and all edges were checked before traversal
    if (expanded.has(entry)) continue;
    expanded.add(entry);
    for (const [name, request] of [...entry.dependencies, ...entry.optionalDependencies]) {
      const dependency = `${name}@${request}`;
      if (!seen.has(dependency)) queue.push(dependency);
    }
  }
  return seen;
}

function fingerprints(entries: Map<string, LockEntry>): Map<string, string> {
  const byEntry = new Map<LockEntry, string>();
  const bySelector = new Map<string, string>();
  const sorted = (dependencies: Map<string, string>) => [...dependencies].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [selector, entry] of entries) {
    let fingerprint = byEntry.get(entry);
    if (fingerprint === undefined) {
      fingerprint = JSON.stringify([entry.version, entry.resolved, entry.integrity ?? null, sorted(entry.dependencies), sorted(entry.optionalDependencies)]);
      byEntry.set(entry, fingerprint);
    }
    bySelector.set(selector, fingerprint);
  }
  return bySelector;
}

/**
 * Possible affected direct dependencies, or undefined when full validation must be retained.
 * Exact requests from EACH manifest are required: a root name alone cannot identify its selector.
 * An unchanged selector map returns []; the caller must not clear a manifest dependency edit unless
 * its changed names are covered by the result. No semver resolution or package code is executed.
 */
export function yarnLockAffectedDependencies(
  oldContent: string | undefined,
  newContent: string | undefined,
  beforeDirect: DirectDependencies,
  afterDirect: DirectDependencies,
): string[] | undefined {
  const before = parse(oldContent);
  const after = parse(newContent);
  if (!before || !after) return undefined;
  const oldRoots = roots(before, beforeDirect);
  const newRoots = roots(after, afterDirect);
  if (!oldRoots || !newRoots) return undefined;
  const oldFingerprints = fingerprints(before);
  const newFingerprints = fingerprints(after);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((selector) => oldFingerprints.get(selector) !== newFingerprints.get(selector));
  if (!changed.length) return [];
  const oldReachable = reachable(before, oldRoots);
  const newReachable = reachable(after, newRoots);
  if (changed.some((selector) => !oldReachable.has(selector) && !newReachable.has(selector))) return undefined;
  return [...new Set([...Object.keys(beforeDirect), ...Object.keys(afterDirect)])].sort();
}
