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
 * FAILING CLOSED. Anything this does not model returns undefined, and the caller keeps the global
 * lockfile signal: another lockfile format, an unparseable or oversized file, workspaces (an importer
 * other than "."), `link:` or `file:` dependencies, a change to any top-level field such as
 * `settings`, `overrides`, `patchedDependencies` or `catalogs`, a missing edge, or a changed package no
 * direct dependency reaches.
 */
import { parse } from "yaml";

type YamlRecord = Record<string, unknown>;

interface Lockfile {
  importer: Record<string, { field: string; entry: unknown; version: string }>;
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

function parseLockfile(content: string | undefined): Lockfile | undefined {
  if (content === undefined || content.length > MAX_CONTENT_LENGTH) return undefined;
  let raw: unknown;
  try { raw = parse(content, { maxAliasCount: 0 }); } catch { return undefined; }
  if (!isRecord(raw) || String(raw.lockfileVersion) !== "9.0") return undefined;
  const importers = raw.importers;
  if (!isRecord(importers) || Object.keys(importers).length !== 1 || !isRecord(importers["."])) return undefined;
  const root = importers["."];
  if (Object.keys(root).some((field) => !IMPORTER_DEPENDENCY_FIELDS.includes(field))) return undefined;
  const importer: Lockfile["importer"] = Object.create(null);
  for (const field of IMPORTER_DEPENDENCY_FIELDS) {
    const record = root[field];
    if (record === undefined) continue;
    if (!isRecord(record)) return undefined;
    for (const [name, entry] of Object.entries(record)) {
      if (!isRecord(entry) || typeof entry.version !== "string" || Object.hasOwn(importer, name)) return undefined;
      importer[name] = { field, entry, version: entry.version };
    }
  }
  const packages = raw.packages ?? {};
  const snapshots = raw.snapshots ?? {};
  if (!isRecord(packages) || !isRecord(snapshots) || !Object.values(snapshots).every(isRecord)) return undefined;
  const rest = JSON.stringify(Object.entries(raw).filter(([field]) => !MODELLED_FIELDS.has(field)).sort(([a], [b]) => a.localeCompare(b)));
  return { importer, packages, snapshots: snapshots as Record<string, YamlRecord>, rest };
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
 * The direct dependencies (names from the root package.json, old and new) whose request or
 * installed tree differs between two pnpm-lock.yaml contents, or undefined when the change cannot
 * be attributed.
 */
export function pnpmLockAffectedDependencies(oldContent: string | undefined, newContent: string | undefined, directDependencies: readonly string[]): string[] | undefined {
  const before = parseLockfile(oldContent);
  const after = parseLockfile(newContent);
  if (!before || !after || before.rest !== after.rest) return undefined;
  const changedPackages = new Set<string>();
  for (const key of new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])) {
    if (JSON.stringify(before.packages[key]) !== JSON.stringify(after.packages[key])) changedPackages.add(key);
  }
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(before.snapshots), ...Object.keys(after.snapshots)])) {
    if (changedPackages.has(packageKey(key)) || JSON.stringify(before.snapshots[key]) !== JSON.stringify(after.snapshots[key])) changed.add(key);
  }
  const names = new Set([...directDependencies, ...Object.keys(before.importer), ...Object.keys(after.importer)]);
  const affected = new Set<string>();
  const attributed = new Set<string>();
  for (const name of names) {
    const requests = [before.importer[name], after.importer[name]];
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
  if ([...changed].some((key) => !attributed.has(key))) return undefined;
  const attributedPackages = new Set([...attributed].map(packageKey));
  if ([...changedPackages].some((key) => !attributedPackages.has(key))) return undefined;
  return [...affected].sort();
}
