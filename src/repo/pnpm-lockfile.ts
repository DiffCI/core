// SPDX-License-Identifier: MIT
/**
 * Which direct dependencies did a pnpm-lock.yaml change reach? (2026-11-02.)
 *
 * WHY. npm and Yarn Classic dependency bumps are attributed to the direct dependencies they reach
 * (npm-lockfile.ts, yarn-lockfile.ts); a pnpm lockfile change still forced the full suite. The
 * question is the same: which direct dependencies now resolve to a different installed tree. The
 * impact analyzer then selects the tests that import those packages.
 *
 * THE MODEL. Lockfile format 9.0 (pnpm 9 and 10) lists the root project's requests under
 * `importers["."]`, each with the `version` it resolved to. Every resolved package has a `packages`
 * entry keyed `name@version` (its resolution) and one `snapshots` entry per peer context, keyed
 * `name@version(peer@x)`, holding its own resolved dependency edges. A snapshot changed when its
 * entry or its package entry changed, or was added or removed. A direct dependency is affected when
 * its request changed, or its snapshot closure, in the old or the new lockfile, contains a changed
 * snapshot. Peers resolved for a snapshot are among its edges and in its key, so a peer bump changes
 * every snapshot that depends on that peer.
 *
 * WORKSPACES (2026-11-27). A pnpm workspace records one importer per workspace package, keyed by its
 * directory. Each importer's registry requests are attributed like the root's, and the affected
 * names are the union over importers: a test selected for a name that only another importer bumped
 * runs more tests, never fewer. A workspace request (`version: link:../pkg`) is not a resolved
 * package. It must point at another importer and stay the same on both sides, because whatever it
 * reaches is that importer's own requests, attributed there.
 *
 * FAILING CLOSED. Anything this does not model returns undefined, and the caller keeps the global
 * lockfile signal: another lockfile format, an unparseable or oversized file, an importer added or
 * removed, a `link:` request that changed or points outside the importers, `file:` or `workspace:`
 * references, an importer field other than the dependency sections (`dependenciesMeta`,
 * `publishDirectory`), a change to any top-level field such as `settings`, `overrides`,
 * `patchedDependencies` or `catalogs`, a missing or local snapshot edge, or a changed package no
 * registry request reaches. The single-project entry point still rejects any importer other than ".".
 */
import { posix } from "node:path";
import { parse } from "yaml";

type YamlRecord = Record<string, unknown>;

interface Importer {
  /** Registry requests, by name, with the version they resolved to. */
  requests: Record<string, { field: string; entry: unknown; version: string }>;
  /** Workspace requests, by name, as the importer directory they link to. */
  links: Record<string, string>;
}

interface Lockfile {
  importers: Record<string, Importer>;
  packages: Record<string, unknown>;
  snapshots: Record<string, YamlRecord>;
  rest: string;
}

// Bounded independently of the repository's Git output limit, like yarn-lockfile.ts.
const MAX_CONTENT_LENGTH = 8 * 1024 * 1024;
const IMPORTER_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const SNAPSHOT_EDGE_FIELDS = ["dependencies", "optionalDependencies"];
const MODELLED_FIELDS = new Set(["lockfileVersion", "importers", "packages", "snapshots"]);

const isRecord = (value: unknown): value is YamlRecord => !!value && typeof value === "object" && !Array.isArray(value);

/** The packages key for a snapshot key: its resolution without the peer suffix. */
function packageKey(snapshot: string): string {
  const index = snapshot.indexOf("(");
  return index === -1 ? snapshot : snapshot.slice(0, index);
}

/** The snapshot an edge `name: reference` points to, or undefined for a local reference. */
function snapshotKey(name: string, reference: string): string | undefined {
  if (/^(?:link|file|workspace):/.test(reference)) return undefined;
  // An alias edge names the real package: `string-width-cjs: string-width@4.2.3`.
  return packageKey(reference).indexOf("@", 1) > 0 ? reference : `${name}@${reference}`;
}

/** A repository-relative importer key: "." or a normalized path that stays inside the repository. */
function importerKey(path: string): string | undefined {
  if (path === ".") return path;
  if (path === "" || path.includes("\\") || posix.isAbsolute(path) || posix.normalize(path) !== path
    || path.endsWith("/") || path === ".." || path.startsWith("../")) return undefined;
  return path;
}

/** The importer a `link:` request from `dir` points at, or undefined when it leaves the repository. */
function linkTarget(dir: string, reference: string): string | undefined {
  const target = posix.normalize(posix.join(dir, reference.slice("link:".length))).replace(/\/$/, "");
  return importerKey(target === "" ? "." : target);
}

function parseLockfile(content: string | undefined, workspace: boolean): Lockfile | undefined {
  if (content === undefined || content.length > MAX_CONTENT_LENGTH) return undefined;
  let raw: unknown;
  try { raw = parse(content, { maxAliasCount: 0 }); } catch { return undefined; }
  if (!isRecord(raw) || String(raw.lockfileVersion) !== "9.0") return undefined;
  const rawImporters = raw.importers;
  if (!isRecord(rawImporters) || !isRecord(rawImporters["."])) return undefined;
  if (!workspace && Object.keys(rawImporters).length !== 1) return undefined;
  const importers: Lockfile["importers"] = Object.create(null);
  for (const [path, value] of Object.entries(rawImporters)) {
    const dir = importerKey(path);
    if (dir === undefined || !isRecord(value) || Object.keys(value).some((field) => !IMPORTER_DEPENDENCY_FIELDS.includes(field))) return undefined;
    const importer: Importer = { requests: Object.create(null), links: Object.create(null) };
    for (const field of IMPORTER_DEPENDENCY_FIELDS) {
      const record = value[field];
      if (record === undefined) continue;
      if (!isRecord(record)) return undefined;
      for (const [name, entry] of Object.entries(record)) {
        if (!isRecord(entry) || typeof entry.version !== "string" || Object.hasOwn(importer.requests, name) || Object.hasOwn(importer.links, name)) return undefined;
        if (entry.version.startsWith("link:")) {
          const target = workspace ? linkTarget(dir, entry.version) : undefined;
          if (target === undefined) return undefined;
          importer.links[name] = target;
        } else if (/^(?:file|workspace):/.test(entry.version)) {
          return undefined;
        } else {
          importer.requests[name] = { field, entry, version: entry.version };
        }
      }
    }
    importers[dir] = importer;
  }
  // A workspace request reaches another importer's requests; one pointing anywhere else is not modelled.
  if (Object.values(importers).some((importer) => Object.values(importer.links).some((target) => !Object.hasOwn(importers, target)))) return undefined;
  const packages = raw.packages ?? {};
  const snapshots = raw.snapshots ?? {};
  if (!isRecord(packages) || !isRecord(snapshots) || !Object.values(snapshots).every(isRecord)) return undefined;
  const rest = JSON.stringify(Object.entries(raw).filter(([field]) => !MODELLED_FIELDS.has(field)).sort(([a], [b]) => a.localeCompare(b)));
  return { importers, packages, snapshots: snapshots as Record<string, YamlRecord>, rest };
}

/** The snapshot keys reachable from `root`, or undefined when an edge is local or dangling. */
function closure(lock: Lockfile, root: string): Set<string> | undefined {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (seen.has(key)) continue;
    const entry = lock.snapshots[key];
    if (!entry) return undefined;
    seen.add(key);
    for (const field of SNAPSHOT_EDGE_FIELDS) {
      const edges = entry[field];
      if (edges === undefined) continue;
      if (!isRecord(edges)) return undefined;
      for (const [name, reference] of Object.entries(edges)) {
        const next = typeof reference === "string" ? snapshotKey(name, reference) : undefined;
        if (next === undefined) return undefined;
        if (!seen.has(next)) queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * The registry requests, per importer, whose request or installed tree differs between two parsed
 * lockfiles, unioned by name, or undefined when the change cannot be attributed.
 */
function attribute(before: Lockfile, after: Lockfile, directByImporter: Readonly<Record<string, readonly string[]>>): string[] | undefined {
  if (before.rest !== after.rest) return undefined;
  const dirs = Object.keys(after.importers).sort();
  if (JSON.stringify(Object.keys(before.importers).sort()) !== JSON.stringify(dirs)) return undefined;
  const links = (importer: Importer) => JSON.stringify(Object.entries(importer.links).sort(([a], [b]) => a.localeCompare(b)));
  if (dirs.some((dir) => links(before.importers[dir]!) !== links(after.importers[dir]!))) return undefined;
  const changedPackages = new Set<string>();
  for (const key of new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])) {
    if (JSON.stringify(before.packages[key]) !== JSON.stringify(after.packages[key])) changedPackages.add(key);
  }
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(before.snapshots), ...Object.keys(after.snapshots)])) {
    if (changedPackages.has(packageKey(key)) || JSON.stringify(before.snapshots[key]) !== JSON.stringify(after.snapshots[key])) changed.add(key);
  }
  const affected = new Set<string>();
  const attributed = new Set<string>();
  for (const dir of dirs) {
    const sides = [before.importers[dir]!, after.importers[dir]!];
    const names = new Set([...(directByImporter[dir] ?? []), ...Object.keys(sides[0]!.requests), ...Object.keys(sides[1]!.requests)]);
    for (const name of names) {
      // A workspace request is attributed through the linked importer's own requests.
      if (Object.hasOwn(sides[1]!.links, name)) continue;
      const requests = [sides[0]!.requests[name], sides[1]!.requests[name]];
      if (JSON.stringify(requests[0]) !== JSON.stringify(requests[1])) affected.add(name);
      for (const [index, lock] of [before, after].entries()) {
        const request = requests[index];
        if (!request) continue;
        const root = snapshotKey(name, request.version);
        const reached = root === undefined ? undefined : closure(lock, root);
        if (!reached) return undefined;
        for (const key of reached) {
          if (!changed.has(key)) continue;
          affected.add(name);
          attributed.add(key);
        }
      }
    }
  }
  if ([...changed].some((key) => !attributed.has(key))) return undefined;
  const attributedPackages = new Set([...attributed].map(packageKey));
  if ([...changedPackages].some((key) => !attributedPackages.has(key))) return undefined;
  return [...affected].sort();
}

/**
 * The direct dependencies (names from the root package.json, old and new) whose request or
 * installed tree differs between two pnpm-lock.yaml contents, or undefined when the change cannot
 * be attributed.
 */
export function pnpmLockAffectedDependencies(oldContent: string | undefined, newContent: string | undefined, directDependencies: readonly string[]): string[] | undefined {
  const before = parseLockfile(oldContent, false);
  const after = parseLockfile(newContent, false);
  return before && after ? attribute(before, after, { ".": directDependencies }) : undefined;
}

/** The importer directories of a pnpm-lock.yaml, "." included, or undefined when it is not modelled. */
export function pnpmLockImporters(content: string | undefined): string[] | undefined {
  const lock = parseLockfile(content, true);
  return lock ? Object.keys(lock.importers).sort() : undefined;
}

export interface PnpmWorkspaceLockImpact {
  /** Registry requests whose request or installed tree changed in some importer, unioned by name. */
  dependencies: string[];
  /** Every name each importer declares in the new lockfile, workspace links included. */
  declared: Record<string, string[]>;
}

/**
 * Workspace attribution: `directByImporter` maps each importer directory to the names its
 * package.json declares (old and new). Undefined when the change cannot be attributed.
 */
export function pnpmWorkspaceLockImpact(oldContent: string | undefined, newContent: string | undefined, directByImporter: Readonly<Record<string, readonly string[]>>): PnpmWorkspaceLockImpact | undefined {
  const before = parseLockfile(oldContent, true);
  const after = parseLockfile(newContent, true);
  if (!before || !after) return undefined;
  const dependencies = attribute(before, after, directByImporter);
  if (!dependencies) return undefined;
  const declared: Record<string, string[]> = {};
  for (const dir of Object.keys(after.importers).sort()) {
    const importer = after.importers[dir]!;
    declared[dir] = [...Object.keys(importer.requests), ...Object.keys(importer.links)].sort();
  }
  return { dependencies, declared };
}
