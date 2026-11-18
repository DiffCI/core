// SPDX-License-Identifier: MIT
/**
 * Conservative Berry npm candidates, gated separately on an explicit node-modules linker.
 * Like Classic, a semantic change widens to every direct dependency: the lockfile does not record
 * the installed hoisting layout. Unknown formats, protocols, fields and missing edges fail closed.
 * A lone workspace:. record describes the project itself, not a workspace dependency; when present
 * it must agree with the manifest. All other workspace records and edges are unsupported.
 */
import { parseDocument, visit } from "yaml";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isExactVersion, isRegistryRequest } from "./yarn-lockfile.js";

type Direct = Readonly<Record<string, string>>;
type RecordMap = Map<string, unknown>;
interface Entry { edges: string[]; fingerprint: string }
interface Lock { entries: Map<string, Entry>; metadata: string; project?: string }
const NAME = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const record = (value: unknown): value is RecordMap => value instanceof Map && [...value.keys()].every((key) => typeof key === "string");

function yaml(content: string | undefined): RecordMap | undefined {
  if (!content || content.length > 8 * 1024 * 1024) return undefined;
  const lines = content.split(/\r?\n/);
  if (lines.length > 100_000 || lines.some((line) => line.length > 16_384)) return undefined;
  try {
    const doc = parseDocument(content, { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) return undefined;
    let unsupported = false;
    visit(doc, { Node(_key, node, path) { if (node.anchor || node.tag || path.length > 20) unsupported = true; }, Alias() { unsupported = true; } });
    if (unsupported) return undefined;
    const value: unknown = doc.toJS({ mapAsMap: true, maxAliasCount: 0 });
    return record(value) ? value : undefined;
  } catch { return undefined; }
}

/** Do not interpolate environment-dependent settings or silently ignore additional configuration.
 * Yarn reads environment keys case-insensitively, including YARN_RC_FILENAME and plugin overrides.
 * The caller must analyze in the environment in which the selected tests will run. */
export function berryNodeModulesConfig(content: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (Object.keys(env).some((key) => /^yarn_/i.test(key) && env[key] !== undefined)) return false;
  const config = yaml(content);
  return !!config && config.size === 1 && config.get("nodeLinker") === "node-modules";
}

/** The project file overrides the linker, but inherited config can still inject plugins or change
 * resolution. This first subset requires a standalone checkout without those additional inputs. */
export function berryRuntimeConfig(repoPath: string | undefined): boolean {
  try {
    const root = realpathSync(repoPath ?? process.cwd());
    const configPath = join(root, ".yarnrc.yml");
    const configStat = lstatSync(configPath);
    if (!configStat.isFile() || configStat.size > 65_536 || !berryNodeModulesConfig(readFileSync(configPath, "utf8"))) return false;
    const extra = new Set([join(root, ".env.yarn"), join(homedir(), ".yarnrc.yml")]);
    let parent = dirname(root);
    while (true) {
      extra.add(join(parent, ".yarnrc.yml"));
      if (dirname(parent) === parent) break;
      parent = dirname(parent);
    }
    extra.delete(join(root, ".yarnrc.yml"));
    for (const path of extra) {
      try { lstatSync(path); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    return true;
  } catch { return false; }
}

function descriptor(name: string, request: string): string | undefined {
  const range = request.startsWith("npm:") ? request.slice(4) : request;
  return NAME.test(name) && isRegistryRequest(range) ? `${name}@npm:${range}` : undefined;
}

function selectors(key: string): string[] | undefined {
  const values = key.split(/, */);
  let packageName: string | undefined;
  for (const value of values) {
    const separator = value.indexOf("@", value.startsWith("@") ? 1 : 0);
    const name = value.slice(0, separator);
    const request = value.slice(separator + 1);
    if (separator < 1 || !request.startsWith("npm:") || descriptor(name, request) !== value || (packageName !== undefined && packageName !== name)) return undefined;
    packageName = name;
  }
  return values;
}

function dependencies(value: unknown): Map<string, string> | undefined {
  if (value === undefined) return new Map();
  if (!record(value)) return undefined;
  const result = new Map<string, string>();
  for (const [name, request] of value) {
    if (typeof request !== "string") return undefined;
    const key = descriptor(name, request);
    if (!key) return undefined;
    result.set(name, key);
  }
  return result;
}

const sorted = (map: Map<string, unknown>) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
function parse(content: string | undefined, direct: Direct, projectName?: string): Lock | undefined {
  const raw = yaml(content);
  if (!raw) return undefined;
  const metadata = raw.get("__metadata");
  const cacheKey = record(metadata) ? metadata.get("cacheKey") : undefined;
  // Known Berry formats only; a future serializer needs a separate review.
  if (!record(metadata) || ![4, 6, 8].includes(metadata.get("version") as number)
    || [...metadata.keys()].some((key) => key !== "version" && key !== "cacheKey")
    || (metadata.has("cacheKey") && !["string", "number"].includes(typeof metadata.get("cacheKey")))
    || (typeof cacheKey === "number" && (!Number.isSafeInteger(cacheKey) || cacheKey < 0))
    || (metadata.has("cacheKey") && !/^[a-zA-Z0-9]+$/.test(String(metadata.get("cacheKey"))))) return undefined;
  const entries = new Map<string, Entry>();
  let project: string | undefined;
  for (const [key, value] of raw) {
    if (key === "__metadata") continue;
    if (!record(value) || [...value.keys()].some((field) => !["version", "resolution", "checksum", "languageName", "linkType", "dependencies", "bin"].includes(field))) return undefined;
    const deps = dependencies(value.get("dependencies"));
    if (!deps) return undefined;
    if (key.endsWith("@workspace:.")) {
      if (project || !projectName || !NAME.test(projectName) || key !== `${projectName}@workspace:.`
        || value.get("resolution") !== key || value.get("version") !== "0.0.0-use.local" || value.get("linkType") !== "soft"
        || value.has("checksum") || value.has("bin")
        || (value.has("languageName") && !["node", "unknown"].includes(value.get("languageName") as string))
        || deps.size !== Object.keys(direct).length
        || Object.entries(direct).some(([name, request]) => deps.get(name) !== descriptor(name, request))) return undefined;
      project = JSON.stringify([key, value.get("languageName")]);
      continue;
    }
    const keys = selectors(key);
    const version = value.get("version");
    if (!keys || typeof version !== "string" || !isExactVersion(version) || value.get("languageName") !== "node" || value.get("linkType") !== "hard") return undefined;
    const name = keys[0]!.slice(0, keys[0]!.indexOf("@", keys[0]!.startsWith("@") ? 1 : 0));
    if (value.get("resolution") !== `${name}@npm:${version}`) return undefined;
    const checksum = value.get("checksum");
    if (checksum !== undefined && (typeof checksum !== "string" || !/^(?:[a-zA-Z0-9]+\/)?[a-f0-9]{128}$/.test(checksum))) return undefined;
    const bin = value.get("bin");
    if (bin !== undefined && (!record(bin) || [...bin.values()].some((path) => typeof path !== "string"))) return undefined;
    const entry: Entry = { edges: [...deps.values()], fingerprint: JSON.stringify([version, value.get("resolution"), checksum ?? null, sorted(deps), bin ? sorted(bin as RecordMap) : null]) };
    for (const selector of keys) {
      if (entries.has(selector) || entries.size >= 100_000) return undefined;
      entries.set(selector, entry);
    }
  }
  if ([...entries.values()].some((entry) => entry.edges.some((edge) => !entries.has(edge)))) return undefined;
  return { entries, metadata: JSON.stringify(sorted(metadata)), project };
}

function reachable(lock: Lock, direct: Direct): Set<Entry> | undefined {
  const queue: Entry[] = [];
  for (const [name, request] of Object.entries(direct)) {
    const key = descriptor(name, request);
    const entry = key ? lock.entries.get(key) : undefined;
    if (!entry) return undefined;
    queue.push(entry);
  }
  const seen = new Set<Entry>();
  while (queue.length) {
    const entry = queue.pop()!;
    if (seen.has(entry)) continue;
    seen.add(entry);
    for (const key of entry.edges) queue.push(lock.entries.get(key)!);
  }
  return seen;
}

/** Possible affected roots, or undefined to retain full validation. Call only after linker proof. */
export function berryLockAffectedDependencies(oldContent: string | undefined, newContent: string | undefined, beforeDirect: Direct, afterDirect: Direct, beforeName?: string, afterName?: string): string[] | undefined {
  const before = parse(oldContent, beforeDirect, beforeName);
  const after = parse(newContent, afterDirect, afterName);
  if (!before || !after || before.metadata !== after.metadata || before.project !== after.project) return undefined;
  const oldReachable = reachable(before, beforeDirect);
  const newReachable = reachable(after, afterDirect);
  if (!oldReachable || !newReachable) return undefined;
  const changed = [...new Set([...before.entries.keys(), ...after.entries.keys()])].filter((key) => before.entries.get(key)?.fingerprint !== after.entries.get(key)?.fingerprint);
  if (changed.some((key) => !oldReachable.has(before.entries.get(key)!) && !newReachable.has(after.entries.get(key)!))) return undefined;
  return changed.length ? [...new Set([...Object.keys(beforeDirect), ...Object.keys(afterDirect)])].sort() : [];
}
