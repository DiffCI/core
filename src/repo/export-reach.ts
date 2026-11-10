// SPDX-License-Identifier: MIT
import type { ModuleBindings } from "./types.js";

/**
 * Export-level reach (2026-11-10). File-level selection treats `import { x } from "pkg"` as a dependency on
 * every file `pkg`'s barrel re-exports, which is what `vitest --changed` does too. On payloadcms/payload that
 * selects about 230 of 520 test files for a change in one hierarchy helper. Following re-exports by name
 * inside packages that declare `sideEffects: false` (the contract bundlers rely on to drop unused re-exports)
 * selected 16.5% of test files on 31 code-only commits against Vitest's 23.5%.
 *
 * `touched` is every file whose code a test runs or whose exports were consulted to resolve one of its
 * names, so a changed barrel or a changed `export *` source still selects. Whenever the walk cannot tell
 * which names a module binds (no bindings, opaque exports, a package without the side-effect contract, a
 * name it cannot find) it counts the whole module, as file-level selection does.
 */
export function exportLevelReach(
  start: string,
  bindings: Readonly<Record<string, ModuleBindings>>,
  runtimeDependencies: (path: string) => readonly string[],
  /** Tests may be type-checked as they run: a type import of a target takes the whole target. */
  followTypes = false,
): Set<string> {
  const touched = new Set<string>();
  const ran = new Set<string>();
  const whole = new Set<string>();
  const seen = new Set<string>();
  const queue: [string, string][] = [[start, "*"]];

  const runBody = (file: string): void => {
    if (ran.has(file)) return;
    ran.add(file);
    const own = bindings[file];
    for (const target of runtimeDependencies(file)) {
      const imported = own?.imports[target];
      if (followTypes && own?.typeImports?.includes(target)) {
        queue.push([target, "*"]);
      } else if (imported === undefined) {
        // A target only re-exported is evaluated but contributes nothing unless a name is asked of it.
        if (own?.reexports[target] && bindings[target]?.sideEffectFree) continue;
        queue.push([target, "*"]);
      } else if (imported === "*" || !bindings[target]?.sideEffectFree) {
        queue.push([target, "*"]);
      } else {
        for (const name of imported) queue.push([target, name]);
      }
    }
  };

  const takeWhole = (file: string): void => {
    if (whole.has(file)) return;
    whole.add(file);
    runBody(file);
    for (const target of Object.keys(bindings[file]?.reexports ?? {})) queue.push([target, "*"]);
  };

  const defines = (file: string, name: string, visiting: Set<string>): boolean => {
    if (visiting.has(file)) return false;
    visiting.add(file);
    touched.add(file);
    const own = bindings[file];
    if (!own || own.opaque || !own.sideEffectFree) return true;
    if (own.locals.includes(name)) return true;
    for (const forwarded of Object.values(own.reexports)) {
      if (forwarded.namespaces.includes(name) || forwarded.pairs.some(([exported]) => exported === name)) return true;
    }
    return Object.entries(own.reexports).some(([target, forwarded]) => forwarded.star && defines(target, name, visiting));
  };

  while (queue.length) {
    const [file, name] = queue.pop()!;
    const key = `${file}\0${name}`;
    if (seen.has(key) || whole.has(file)) continue;
    seen.add(key);
    touched.add(file);
    const own = bindings[file];
    if (name === "*" || !own || own.opaque || !own.sideEffectFree) { takeWhole(file); continue; }
    if (own.locals.includes(name)) { runBody(file); continue; }
    let found = false;
    for (const [target, forwarded] of Object.entries(own.reexports)) {
      if (forwarded.namespaces.includes(name)) { queue.push([target, "*"]); found = true; }
      for (const [exported, imported] of forwarded.pairs) if (exported === name) { queue.push([target, imported]); found = true; }
    }
    if (!found) {
      for (const [target, forwarded] of Object.entries(own.reexports)) {
        if (forwarded.star && defines(target, name, new Set())) { queue.push([target, name]); found = true; }
      }
    }
    if (!found) takeWhole(file);
  }
  for (const file of ran) touched.add(file);
  return touched;
}
