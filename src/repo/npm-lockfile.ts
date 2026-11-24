// SPDX-License-Identifier: MIT
/**
 * Which direct dependencies did a package-lock.json change reach? (2026-10-28.)
 *
 * WHY. A dependency bump changes package.json and the lockfile together, and each used to force the
 * full suite. In one dogfood repository's paired experiment those two signals were behind 19 of 40 runs.
 * A bump can only change the behaviour of code that loads the bumped package, and code loads a
 * transitive package only through a direct dependency. So the question for selection is which direct
 * dependencies now resolve to a different installed tree; the impact analyzer then selects the tests
 * that import those packages, and falls back when a package is not imported by any repository file.
 *
 * THE MODEL. npm lockfiles v2 and v3 list every installed package under `packages`, keyed by its
 * install path (`node_modules/a`, `node_modules/a/node_modules/b`). An entry whose content changed, or
 * which was added or removed, is a changed install. Each install's own `dependencies`,
 * `optionalDependencies` and `peerDependencies` are resolved the way Node does, by walking up the
 * install path. A direct dependency is affected when its closure, in the old or the new lockfile,
 * contains a changed install.
 *
 * FAILING CLOSED. Anything this does not model returns undefined, and the caller keeps the global
 * lockfile signal: lockfile v1, an unparseable file, workspace or linked entries (keys outside
 * `node_modules/`), or a changed install no direct dependency reaches (a hoisting change the model
 * cannot attribute).
 */

interface LockEntry {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  link?: boolean;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

function parse(content: string | undefined): Record<string, LockEntry> | undefined {
  if (content === undefined) return undefined;
  let lock: Lockfile;
  try { lock = JSON.parse(content) as Lockfile; } catch { return undefined; }
  if (!lock || typeof lock !== "object" || typeof lock.lockfileVersion !== "number" || lock.lockfileVersion < 2) return undefined;
  if (!lock.packages || typeof lock.packages !== "object") return undefined;
  return lock.packages;
}

/** The install path a package named `name`, required from `fromKey`, resolves to. */
function resolveInstall(packages: Record<string, LockEntry>, fromKey: string, name: string): string | undefined {
  let base = fromKey;
  while (true) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return undefined;
    const index = base.lastIndexOf("/node_modules/");
    base = index === -1 ? "" : base.slice(0, index);
  }
}

function closure(packages: Record<string, LockEntry>, root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (seen.has(key) || !packages[key]) continue;
    seen.add(key);
    const entry = packages[key]!;
    for (const field of [entry.dependencies, entry.optionalDependencies, entry.peerDependencies]) {
      for (const name of Object.keys(field ?? {})) {
        const resolved = resolveInstall(packages, key, name);
        if (resolved && !seen.has(resolved)) queue.push(resolved);
      }
    }
  }
  return seen;
}

/**
 * Every package installed at the root node_modules whose installed tree (the package and everything it
 * loads) differs between two package-lock.json contents, or undefined when the change cannot be modelled
 * (2026-11-24). A package absent from both lockfiles is unchanged.
 *
 * WHY. With an npm lockfile change, any import of a package the root package.json does not declare made the
 * whole change a full run, because attribution reaches only declared roots. DentalPresence imports sharp
 * (installed through next) and loads libphonenumber-js from a folder outside the project, so every lockfile
 * change, including each DiffCI version bump, ran the full suite although neither package moved.
 */
export function npmLockChangedTrees(oldContent: string | undefined, newContent: string | undefined): string[] | undefined {
  const before = parse(oldContent);
  const after = parse(newContent);
  if (!before || !after) return undefined;
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "") continue;
    if (!key.startsWith("node_modules/")) return undefined;
    if (before[key]?.link || after[key]?.link) return undefined;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.add(key);
  }
  const roots = new Set<string>();
  for (const packages of [before, after]) {
    for (const key of Object.keys(packages)) {
      const name = /^node_modules\/((?:@[^/]+\/)?[^/@][^/]*)$/.exec(key)?.[1];
      if (name) roots.add(name);
    }
  }
  const trees: string[] = [];
  for (const name of roots) {
    const root = `node_modules/${name}`;
    // Anything installed beneath the package's own directory is part of it, declared or bundled.
    const touched = changed.has(root) || [...changed].some((key) => key.startsWith(`${root}/`))
      || [before, after].some((packages) => packages[root] !== undefined && [...closure(packages, root)].some((key) => changed.has(key)));
    if (touched) trees.push(name);
  }
  return trees.sort();
}

/**
 * The direct dependencies (names from the root package.json, old and new) whose installed tree
 * differs between two package-lock.json contents, or undefined when the change cannot be attributed.
 */
export function npmLockAffectedDependencies(oldContent: string | undefined, newContent: string | undefined, directDependencies: readonly string[]): string[] | undefined {
  const before = parse(oldContent);
  const after = parse(newContent);
  if (!before || !after) return undefined;
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "") continue; // the root entry mirrors package.json, which the caller compares itself
    if (!key.startsWith("node_modules/")) return undefined;
    if (before[key]?.link || after[key]?.link) return undefined;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.add(key);
  }
  const affected = new Set<string>();
  const attributed = new Set<string>();
  for (const name of directDependencies) {
    for (const packages of [before, after]) {
      const root = `node_modules/${name}`;
      if (!packages[root]) {
        if (changed.has(root)) { affected.add(name); attributed.add(root); }
        continue;
      }
      for (const key of closure(packages, root)) {
        if (!changed.has(key)) continue;
        affected.add(name);
        attributed.add(key);
      }
    }
  }
  if ([...changed].some((key) => !attributed.has(key))) return undefined;
  return [...affected].sort();
}
