// SPDX-License-Identifier: MIT
import type { RepositoryProfile } from "../repo/types.js";
import type { SelectiveTestCommandGroup, SelectiveTestCommandPlan } from "./test-command.js";

/** Cargo target names are literal arguments, not paths, globs, package specs or shell fragments. */
const literalName = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
/** A package is its name, or NAME@VERSION when a dependency shares the name (adapters/rust.ts). */
const packageSpec = /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?$/;

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
    if (!packageSpec.test(packages[path]!) || !literalName.test(target.name)
      || !["lib", "bin", "test", "bench", "example"].includes(target.kind)) {
      return refuse("Invalid Cargo package or test target");
    }
  }
  // A target with `required-features` runs only when Cargo enables those features for its package.
  // Naming it (`--test name`) makes Cargo fail instead of skipping it, so its package stays whole:
  // `cargo test -p name` runs exactly the targets the full run runs for that package.
  const gated = new Set(paths.filter(path => targets[path]!.requiredFeatures !== undefined).map(path => packages[path]!));
  for (const path of paths) {
    const required = targets[path]!.requiredFeatures;
    if (required !== undefined && (!Array.isArray(required) || !required.length || required.some(feature => typeof feature !== "string"))) {
      return refuse("Invalid Cargo package or test target");
    }
  }
  const groups: SelectiveTestCommandGroup[] = [];
  const cratePackages: string[] = [];
  const cratePaths: string[] = [];
  for (const pkg of [...new Set(paths.map(path => packages[path]!))].sort()) {
    const owned = paths.filter(path => packages[path] === pkg);
    if (gated.has(pkg)) { cratePackages.push(pkg); cratePaths.push(...owned); continue; }
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
  // Each command is its own Cargo invocation, so each must resolve every package's features exactly
  // as the full `cargo test` does (see rustFeatureCoverage in adapters/rust.ts).
  const coverage = profile.rustFeatureCoverage;
  if (!coverage) return refuse("Rust tests require verified Cargo feature resolution");
  const uncovered = (selected: ReadonlySet<string>) => [...selected].sort().flatMap(pkg => coverage.deficits[pkg] ?? [])
    .find(dependency => !coverage.units.some(unit => unit.covers.includes(dependency) && unit.crates.every(name => selected.has(name))));
  const packageGroup = groups.find(group => group.runnerId === "cargo:test:packages");
  if (packageGroup) {
    // When testing only the selected crates would build a shared dependency with fewer features than
    // the full run, add the tested crates of the smallest unit Cargo resolved with the full run's
    // features. Features only grow with the crates selected and never exceed the full run's, so the
    // larger command still builds that dependency exactly as the full run does; it runs more tests
    // than selected, but fewer than the full run. Each round adds a crate, so this ends.
    const selected = new Set(cratePackages);
    for (let missing = uncovered(selected); missing !== undefined; missing = uncovered(selected)) {
      const extra = (unit: { crates: string[] }) => unit.crates.filter(name => !selected.has(name)).length;
      const unit = coverage.units.filter(candidate => candidate.covers.includes(missing!) && candidate.crates.every(name => literalName.test(name)))
        .sort((a, b) => extra(a) - extra(b) || a.crates.join(" ").localeCompare(b.crates.join(" ")))[0];
      if (!unit) break;
      for (const name of unit.crates) selected.add(name);
    }
    const added = [...selected].filter(name => !cratePackages.includes(name)).sort();
    if (added.length) {
      packageGroup.commandSpec = { executable: "cargo", args: ["test", ...[...selected].sort().flatMap(pkg => ["-p", pkg])] };
      packageGroup.label = `Cargo package tests (with ${added.join(", ")} for the full run's features)`;
    }
  }
  for (const group of groups) {
    const args = group.commandSpec.args;
    const selected = new Set(args.flatMap((arg, index) => args[index - 1] === "-p" ? [arg] : []));
    for (const pkg of selected) {
      for (const dependency of coverage.deficits[pkg] ?? []) {
        if (!coverage.units.some(unit => unit.covers.includes(dependency) && unit.crates.every(name => selected.has(name)))) {
          return refuse(`Selected Cargo crates would build ${dependency} with different features than the full cargo test; full validation required`);
        }
      }
    }
  }
  return { commands: groups.map(group => group.commandSpec), groups, unroutedPaths: [] };
}
