// SPDX-License-Identifier: MIT
import type { RepositoryProfile } from "../repo/types.js";
import type { SelectiveTestCommandGroup, SelectiveTestCommandPlan } from "./test-command.js";

/** Cargo target names are literal arguments, not paths, globs, package specs or shell fragments. */
const literalName = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Only the Rust adapter may attest that the repository's invocation is reproducible. Missing
 * evidence (including old cached profiles) must never become a guessed default test command. */
export function planRustTestCommands(profile: RepositoryProfile, selectedPaths: readonly string[]): SelectiveTestCommandPlan {
  const paths = [...new Set(selectedPaths)].sort();
  const refuse = (refusalReason: string): SelectiveTestCommandPlan => ({ commands: [], groups: [], unroutedPaths: paths, refusalReason });
  if (!paths.length) return { commands: [], groups: [], unroutedPaths: [] };
  if (paths.some(path => !path.endsWith(".rs"))) return refuse("Mixed Rust selective execution requires separate CI jobs");
  if (!profile.adapters?.some(adapter => adapter.id === "rust") || profile.rustTestInvocation !== "cargo test") {
    return refuse("Rust tests require verified plain cargo test invocation evidence");
  }
  const blockers = [...(profile.adapterBlockers ?? []), ...profile.adapters.flatMap(adapter => adapter.blockers)];
  if (blockers.length) return refuse(blockers.join("; "));
  // A wrapper or lifecycle phase cannot be replaced by Cargo just because Cargo also appears in CI.
  const scripts = Object.entries(profile.packageJson.scripts).filter(([name, command]) =>
    /^(?:pretest|posttest|test)(?::|$)/.test(name) || /\b(?:cargo|nextest|just)\b/.test(command));
  if (scripts.some(([, command]) => command.trim() !== "cargo test")) {
    return refuse("Rust test wrappers, scripts and Cargo options require full validation");
  }
  const packages = profile.rustTestPackages ?? {};
  const targets = profile.rustTestTargets ?? {};
  const known = new Set(profile.testFilePaths);
  for (const path of paths) {
    if (!known.has(path) || !Object.hasOwn(packages, path) || !Object.hasOwn(targets, path)) {
      return refuse("Rust tests require verified Cargo package and target metadata");
    }
    const target = targets[path]!;
    if (!literalName.test(packages[path]!) || !literalName.test(target.name)
      || !["lib", "bin", "test", "bench", "example"].includes(target.kind)) {
      return refuse("Invalid Cargo package or test target");
    }
  }
  const groups: SelectiveTestCommandGroup[] = [];
  const cratePackages: string[] = [];
  const cratePaths: string[] = [];
  for (const pkg of [...new Set(paths.map(path => packages[path]!))].sort()) {
    const owned = paths.filter(path => packages[path] === pkg);
    const ordinary = owned.filter(path => ["lib", "bin", "test"].includes(targets[path]!.kind));
    if (ordinary.length) {
      // A crate unit-test root represents the whole crate, including doctests. Do not narrow it to
      // --lib/--bin, which would silently omit doctests. Integration-only selections are literal
      // Cargo target names (including explicitly named targets), never filename-derived guesses.
      const integrationOnly = ordinary.every(path => targets[path]!.kind === "test");
      if (!integrationOnly) { cratePackages.push(pkg); cratePaths.push(...ordinary); }
      else {
        const names = [...new Set(ordinary.map(path => targets[path]!.name))].sort();
        const commandSpec = { executable: "cargo", args: ["test", "-p", pkg, ...names.flatMap(name => ["--test", name])] };
        groups.push({ runnerId: `cargo:test:${pkg}`, label: `Cargo tests (${pkg})`, paths: ordinary, commandSpec });
      }
    }
    // These targets are not all run by plain `cargo test`. Keep them explicit instead of assuming
    // a package-wide invocation covers every target reported by Cargo metadata.
    for (const kind of ["bench", "example"] as const) {
      const selected = owned.filter(path => targets[path]!.kind === kind);
      if (!selected.length) continue;
      const names = [...new Set(selected.map(path => targets[path]!.name))].sort();
      const commandSpec = { executable: "cargo", args: ["test", "-p", pkg, ...names.flatMap(name => [`--${kind}`, name])] };
      groups.push({ runnerId: `cargo:test:${pkg}:${kind}`, label: `Cargo ${kind} tests (${pkg})`, paths: selected, commandSpec });
    }
  }
  if (cratePackages.length) {
    // Keep selected crate suites in one Cargo invocation. The adapter separately
    // refuses feature unification that depends on unselected workspace members.
    const commandSpec = { executable: "cargo", args: ["test", ...cratePackages.flatMap(pkg => ["-p", pkg])] };
    groups.unshift({ runnerId: "cargo:test:packages", label: "Cargo package tests", paths: cratePaths.sort(), commandSpec });
  }
  return { commands: groups.map(group => group.commandSpec), groups, unroutedPaths: [] };
}
