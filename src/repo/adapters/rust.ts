import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { contribution, type AdapterContext, type AdapterContribution, type RepositoryAdapter } from "./types.js";

export interface CargoTarget {
  name: string;
  kind: string[];
  src_path: string;
  test: boolean;
  doctest: boolean;
  "required-features"?: string[];
}

export interface CargoPackage {
  id: string;
  name: string;
  version?: string;
  manifest_path: string;
  targets: CargoTarget[];
  source?: string | null;
  dependencies?: Array<{ name: string; features: string[]; uses_default_features: boolean }>;
  features?: Record<string, string[]>;
}

export interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members: string[];
  /** The members plain `cargo test` at the root builds and tests (root package or `default-members`). */
  workspace_default_members?: string[];
  workspace_root: string;
  resolve?: { nodes: Array<{ id: string; dependencies: string[] }> } | null;
}

/** Cargo's own feature resolution (`cargo tree`, format `{p}|{f}`) for the full invocation and for
 * sets of tested crates. Cargo decides features, including resolver 2 and host/target splits. */
export interface CargoFeatureEvidence {
  workspace: string;
  units: Array<{ crates: string[]; tree: string }>;
}

/** Runs Cargo for each set of crates; undefined when any run fails. */
export type CargoFeatureResolver = (units: string[][]) => CargoFeatureEvidence | undefined;

/** Packages whose features change when a tested crate runs without the rest of the full invocation,
 * and the sets of tested crates (each crate alone, and each crate with its dependents) that give a
 * package exactly the full invocation's features. */
export interface RustFeatureCoverage {
  deficits: Record<string, string[]>;
  units: Array<{ crates: string[]; covers: string[] }>;
}

export const CARGO_TREE_ARGS = ["tree", "--offline", "--locked", "--prefix", "none", "-e", "normal,build,dev", "-f", "{p}|{f}"];

/** Package (`name vX.Y.Z`) to the distinct feature sets Cargo resolved for it; undefined when the
 * output is not a feature tree. A package built for both host and target can have two sets. */
export function parseCargoFeatureTree(output: string): Map<string, Set<string>> | undefined {
  const packages = new Map<string, Set<string>>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("|");
    if (separator < 0) continue;
    const name = /^(\S+) (v\S+)/.exec(line.slice(0, separator));
    if (!name) return undefined;
    const features = line.slice(separator + 1).replace(/\s*\(\*\)\s*$/, "").trim();
    if (!/^[A-Za-z0-9_+.:/,-]*$/.test(features)) return undefined;
    const key = `${name[1]} ${name[2]}`;
    let sets = packages.get(key);
    if (!sets) packages.set(key, sets = new Set());
    sets.add(features.split(",").filter(Boolean).sort().join(","));
  }
  return packages.size ? packages : undefined;
}

/** Whether any declaration can make a package's features depend on which crates are selected. With
 * no feature requests, no disabled defaults and no forwarding, every package always gets its default
 * features, whatever subset of the workspace Cargo builds. */
export function cargoFeaturesVary(metadata: CargoMetadata): boolean {
  return metadata.packages.some(pkg => pkg.dependencies?.some(dep => dep.features.length || !dep.uses_default_features)
    || Object.values(pkg.features ?? {}).some(features => features.some(feature => feature.includes("/"))));
}

/** Feature resolution is monotonic in the crates Cargo is asked to build: a selected set gives every
 * package at least the features of any subset and at most those of the full invocation. A package
 * therefore keeps exactly the full invocation's features (per host/target build, since the sets
 * compared are the same) whenever one unit inside the selection already resolves it that way. */
export function rustFeatureCoverage(evidence: CargoFeatureEvidence, members: readonly string[]): RustFeatureCoverage | undefined {
  const full = parseCargoFeatureTree(evidence.workspace);
  if (!full) return undefined;
  const trees = evidence.units.map(unit => ({ crates: [...unit.crates].sort(), tree: parseCargoFeatureTree(unit.tree) }));
  if (trees.some(unit => !unit.tree)) return undefined;
  const same = (sets: Set<string>, key: string) => {
    const expected = full.get(key);
    return expected !== undefined && expected.size === sets.size && [...sets].every(set => expected.has(set));
  };
  const deficits: Record<string, string[]> = {};
  for (const member of members) {
    const alone = trees.find(unit => unit.crates.length === 1 && unit.crates[0] === member);
    if (!alone) return undefined;
    const missing = [...alone.tree!].filter(([key, sets]) => !same(sets, key)).map(([key]) => key).sort();
    if (missing.length) deficits[member] = missing;
  }
  const needed = new Set(Object.values(deficits).flat());
  const units = trees.map(unit => ({ crates: unit.crates, covers: [...unit.tree!].filter(([key, sets]) => needed.has(key) && same(sets, key)).map(([key]) => key).sort() }))
    .filter(unit => unit.covers.length);
  return { deficits, units };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Metadata is external input: incomplete output is not an empty successful graph. */
export function parseCargoMetadata(output: string): CargoMetadata {
  const value: unknown = JSON.parse(output);
  if (!object(value) || !Array.isArray(value.packages) || !strings(value.workspace_members)
    || !value.workspace_members.length || typeof value.workspace_root !== "string" || !isAbsolute(value.workspace_root)) {
    throw new Error("Invalid Cargo workspace metadata");
  }
  for (const pkg of value.packages) {
    if (!object(pkg) || typeof pkg.id !== "string" || !pkg.id || typeof pkg.name !== "string"
      || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(pkg.name) || typeof pkg.manifest_path !== "string"
      || !isAbsolute(pkg.manifest_path) || !Array.isArray(pkg.targets) || !pkg.targets.length
      || (pkg.source !== undefined && pkg.source !== null && typeof pkg.source !== "string")
      || (pkg.version !== undefined && typeof pkg.version !== "string")) {
      throw new Error("Invalid Cargo package metadata");
    }
    for (const target of pkg.targets) {
      if (!object(target) || typeof target.name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(target.name)
        || !strings(target.kind) || !target.kind.length || typeof target.src_path !== "string"
        || !isAbsolute(target.src_path) || typeof target.test !== "boolean" || typeof target.doctest !== "boolean"
        || (target["required-features"] !== undefined && !strings(target["required-features"]))) {
        throw new Error("Invalid Cargo target metadata");
      }
    }
    if (!Array.isArray(pkg.dependencies) || pkg.dependencies.some(dependency => !object(dependency)
      || typeof dependency.name !== "string" || !strings(dependency.features) || typeof dependency.uses_default_features !== "boolean")) throw new Error("Invalid Cargo dependency features");
    if (!object(pkg.features) || Object.values(pkg.features).some(features => !strings(features))) throw new Error("Invalid Cargo features");
  }
  const ids = value.packages.map(pkg => (pkg as CargoPackage).id);
  if (new Set(ids).size !== ids.length || new Set(value.workspace_members).size !== value.workspace_members.length
    || value.workspace_members.some(id => !ids.includes(id))) throw new Error("Incomplete Cargo workspace membership");
  if (value.workspace_default_members !== undefined && (!strings(value.workspace_default_members)
    || value.workspace_default_members.some(id => !(value.workspace_members as string[]).includes(id)))) throw new Error("Invalid Cargo default members");
  return value as unknown as CargoMetadata;
}

function internalPath(root: string, path: string): string | undefined {
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel;
}

/** Resolve a metadata or checkout path against a realpath'd workspace root. */
function resolvedPath(root: string, path: string): string | undefined {
  try {
    return internalPath(root, realpathSync(path));
  } catch { return undefined; }
}

/** Refuse symlink escapes as well as lexical escapes before using a metadata path. */
function repositoryPath(root: string, path: string, known: ReadonlySet<string>): string | undefined {
  const rel = resolvedPath(root, path);
  return rel && known.has(rel) ? rel : undefined;
}

function under(path: string, directory: string): boolean {
  return directory === "" || path.startsWith(`${directory}/`);
}

/** Cargo modules can live under names other adapters exclude. Never silently omit their contents
 * or follow a symlink that aliases another crate's inputs. Without `#[path]` (which falls back),
 * `mod` only loads files below a target root's directory, so only those trees are checked: a
 * symlink or unlisted file elsewhere in the repository cannot become crate source, and neither can a
 * linked non-Rust file inside them. */
function completeRustInventory(root: string, files: ReadonlySet<string>, trees: readonly string[]): boolean {
  const pending = [...new Set(trees)].filter((tree, _, all) => !all.some(other => other !== tree && under(tree, other)));
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        // A linked directory or Rust file can alias module source; a linked LICENSE or README cannot.
        if (path.endsWith(".rs")) return false;
        try { if (statSync(resolve(root, path)).isDirectory()) return false; } catch { /* dangling, not source */ }
        continue;
      }
      if (entry.isDirectory()) {
        // Version control, dependency trees and Cargo's own output never hold module source.
        if (![".git", "node_modules", "target"].includes(entry.name)) pending.push(path);
      } else if (entry.isFile() && path.endsWith(".rs") && !files.has(path)) return false;
    }
  }
  return true;
}

/** A small lexer, not a Rust parser: ignore comments/strings, but never guess
 * a computed include. Nested comments and raw strings must not hide an input. */
function rustInputs(source: string): { inputs: Array<{ path: string; code: boolean }>; paths: string[]; compiles: boolean; navigates: boolean; documentation: boolean; runsPrograms: boolean } | undefined {
  const tokens: Array<{ value: string; literal?: string }> = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i]!)) { i++; continue; }
    if (source.startsWith("//", i)) { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return undefined;
      continue;
    }
    // Byte and C raw strings (`br"\"`, `cr#"say "hi""#`) take no escapes either; read as a `b`/`c`
    // identifier and an ordinary string, a backslash or quote inside would hide the code after them.
    const raw = /^[bc]?r(#{0,255})"/.exec(source.slice(i));
    if (raw) {
      const start = i + raw[0].length, end = source.indexOf(`"${raw[1]}`, start);
      if (end < 0) return undefined;
      tokens.push({ value: "string", literal: source.slice(start, end) }); i = end + raw[1]!.length + 1; continue;
    }
    if (source[i] === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === "\\") i++; i++; }
      if (i >= source.length) return undefined;
      i++;
      let literal: string | undefined;
      try { literal = JSON.parse(source.slice(start, i)) as string; } catch { /* non-JSON Rust escapes stay unknown */ }
      tokens.push({ value: "string", literal }); continue;
    }
    const character = /^'(?:\\.|[^'\\\n])'/.exec(source.slice(i));
    if (character) { i += character[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (identifier) { tokens.push({ value: identifier[0] }); i += identifier[0].length; continue; }
    tokens.push({ value: source[i++]! });
  }
  // Runtime file access is not a blocker by itself, matching the Go and Python adapters: a changed
  // non-Rust file is never a modelled source, so it keeps the full suite whoever reads it. What a
  // dependency edge cannot see is code that reaches another crate's modelled Rust inputs at run or
  // build time. Report literal paths (the caller checks which crates they reach) and Cargo/rustc
  // invocations; ordinary identifiers such as `fs`, `process`, `unsafe` or `metadata` are not inputs.
  const inputs: Array<{ path: string; code: boolean }> = [];
  const paths: string[] = [];
  let compiles = false;
  let runsPrograms = false;
  const includeArguments = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.value === "mod" && tokens[i + 1]?.value === "target" && tokens[i + 2]?.value === ";") return undefined;
    if (tokens[i]!.value === "#") {
      let j = i + 1;
      if (tokens[j]?.value === "!") j++;
      if (tokens[j]?.value === "[") {
        let depth = 1;
        for (j++; j < tokens.length && depth; j++) {
          if (tokens[j]!.value === "[") depth++;
          if (tokens[j]!.value === "]") depth--;
          if (tokens[j]!.value === "path" && tokens[j + 1]?.value === "=") return undefined;
        }
        if (depth) return undefined;
      }
    }
    if (tokens[i]!.value === "use") {
      // A renamed or re-exported include macro could be called under a name we cannot recognize.
      for (let j = i + 1; j < tokens.length && tokens[j]!.value !== ";"; j++) {
        if (["include", "include_str", "include_bytes"].includes(tokens[j]!.value)) return undefined;
      }
      continue;
    }
    if (tokens[i]!.value === "Command" && tokens[i + 1]?.value === ":" && tokens[i + 2]?.value === ":" && tokens[i + 3]?.value === "new"
      && tokens[i + 4]?.value === "(" && /^(?:cargo|rustc|rustdoc)(?:\.exe)?$|^cargo-/.test(tokens[i + 5]?.literal ?? "")) compiles = true;
    // Any other program (a script, a shell, a tool) could read files no Rust edge shows. Running the
    // package's own binary (`env!("CARGO_BIN_EXE_name")`) is Rust code Cargo already models. This is a
    // token heuristic: clap's `Command::new("app")` counts too, which only fails closed.
    if (tokens[i]!.value === "Command" && tokens[i + 1]?.value === ":" && tokens[i + 2]?.value === ":" && tokens[i + 3]?.value === "new"
      && tokens[i + 4]?.value === "(" && !/^(?:cargo|rustc|rustdoc)(?:\.exe)?$|^cargo-/.test(tokens[i + 5]?.literal ?? "")
      && !(tokens[i + 5]?.value === "env" && tokens[i + 6]?.value === "!" && tokens[i + 7]?.value === "(" && /^CARGO_BIN_EXE_/.test(tokens[i + 8]?.literal ?? ""))) runsPrograms = true;
    if (["duct", "xshell", "subprocess"].includes(tokens[i]!.value) || (tokens[i]!.value === "cmd" && tokens[i + 1]?.value === "!")) runsPrograms = true;
    // `env!("CARGO")`, `env::var("RUSTC")` and similar name the toolchain a test is about to run.
    if (["CARGO", "RUSTC", "RUSTDOC", "RUSTC_WRAPPER"].includes(tokens[i]!.literal ?? "")) compiles = true;
    if (!["include", "include_str", "include_bytes"].includes(tokens[i]!.value) || tokens[i + 1]?.value !== "!") continue;
    const close = new Map([["(", ")"], ["[", "]"], ["{", "}"]]).get(tokens[i + 2]?.value ?? "");
    const literal = tokens[i + 3]?.literal;
    let end = i + 4;
    if (tokens[end]?.value === ",") end++;
    if (!close || literal === undefined || tokens[end]?.value !== close || /[\0\r\n\\]/.test(literal)) return undefined;
    inputs.push({ path: literal, code: tokens[i]!.value === "include" });
    includeArguments.add(i + 3);
  }
  let documentation = false;
  tokens.forEach((token, index) => {
    if (token.literal === undefined || includeArguments.has(index)) return;
    if (pathLike(token.literal)) paths.push(token.literal);
    // A test that checks README or docs content at run time (version-sync, link checks and the like):
    // a Markdown name or bare extension (`"md"` in an extension check), or a documentation directory
    // anywhere in the path (`../docs`, `concat!(env!("CARGO_MANIFEST_DIR"), "/../docs")`).
    if (/(?:^|\.)mdx?$|(?:^|[\\/])(?:docs?|documentation)(?:[\\/]|$)/i.test(token.literal)) documentation = true;
  });
  const navigates = navigatesUpward(tokens);
  // Code that climbs out of its crate can walk to README or docs without naming them.
  return { inputs, paths, compiles, navigates, documentation: documentation || navigates, runsPrograms };
}

/** Code that climbs out of its crate directory in code (`.parent()`, `.ancestors()`, `PathBuf::pop`,
 * or a formatted path with a `..` segment) can reach any crate without a literal naming it. Tests
 * that check every crate's files (license headers, generated code) are written this way. Only fires
 * where the file also works with paths, so `node.parent()` in a parser does not count. */
function navigatesUpward(tokens: ReadonlyArray<{ value: string; literal?: string }>): boolean {
  const pathContext = tokens.some(token => ["Path", "PathBuf", "current_dir", "current_exe"].includes(token.value)
    || ["CARGO_MANIFEST_DIR", "CARGO_WORKSPACE_DIR"].includes(token.literal ?? ""));
  if (!pathContext) return false;
  const pathBuf = tokens.some(token => token.value === "PathBuf");
  return tokens.some((token, index) => {
    if (token.literal !== undefined) return /\{[^}]*\}/.test(token.literal) && /(?:^|[\\/}])\.\.(?:[\\/{]|$)/.test(token.literal);
    if (tokens[index - 1]?.value !== "." || tokens[index + 1]?.value !== "(") return false;
    return token.value === "parent" || token.value === "ancestors" || (pathBuf && token.value === "pop");
  });
}

/** A string that names a file or directory rather than ordinary text. */
function pathLike(value: string): boolean {
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value)) return false;
  if (value === "." || value === "..") return true;
  return /[\\/]/.test(value) && !/\s/.test(value) || /(?:^|[\\/])(?:Cargo\.(?:toml|lock)|[^\\/\s]+\.rs)$/.test(value);
}

export function analyzeRustMetadata(context: AdapterContext, output: string, resolveFeatures?: CargoFeatureResolver): AdapterContribution {
  const result = contribution(rustAdapter);
  if (context.files.some(file => /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(file) && changesBuild(resolve(context.repoPath, file)))) {
    result.blockers.push("Custom Cargo configuration requires full validation");
  }
  try {
    const metadata = parseCargoMetadata(output);
    const root = realpathSync(resolve(context.repoPath));
    if (realpathSync(metadata.workspace_root) !== root) {
      result.blockers.push("Rust support requires a Cargo workspace or crate at the repository root");
      return result;
    }
    const known = new Set(context.files);
    const members = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
    // Plain `cargo test` tests only the root package of a non-virtual workspace, or `default-members`.
    // Selecting another member would run tests the full invocation never runs, so only these crates'
    // targets are tests; other members stay sources whose changes reach their tested dependents.
    const defaults = metadata.workspace_default_members;
    if (!defaults) result.blockers.push("Cargo metadata without default workspace members requires full validation; use Cargo 1.71 or later");
    const tested = new Set(defaults ?? []);
    if (new Set(members.map(pkg => pkg.name)).size !== members.length) {
      result.blockers.push("Ambiguous Cargo workspace package names require full validation");
      return result;
    }
    // `cargo test -p NAME` and `cargo tree -p NAME` stop with "specification is ambiguous" when a
    // dependency has a member's name (an older release of the same crate, say). Name such a member
    // NAME@VERSION, which Cargo accepts, or fall back when even that cannot tell them apart.
    const specs = new Map<string, string>();
    for (const pkg of members) {
      const named = metadata.packages.filter(other => other.name === pkg.name);
      if (named.length === 1) specs.set(pkg.id, pkg.name);
      else if (pkg.version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) && named.filter(other => other.version === pkg.version).length === 1) {
        specs.set(pkg.id, `${pkg.name}@${pkg.version}`);
      } else result.blockers.push(`Cargo package ${pkg.name} has no unambiguous package specification; full validation required`);
    }
    const spec = (pkg: CargoPackage) => specs.get(pkg.id) ?? pkg.name;
    const packages: Array<{ pkg: CargoPackage; directory: string; manifest: string }> = [];
    for (const pkg of members) {
      const manifest = repositoryPath(root, pkg.manifest_path, known);
      if (!manifest || !/(?:^|\/)Cargo\.toml$/.test(manifest)) {
        result.blockers.push(`Rust package ${pkg.name} has an unavailable or external manifest`);
        continue;
      }
      const directory = dirname(manifest) === "." ? "" : dirname(manifest);
      packages.push({ pkg, manifest, directory });
      result.sourcePaths.push(manifest);
    }
    // Deepest package wins, regardless of Cargo's package ordering.
    packages.sort((a, b) => b.directory.length - a.directory.length || a.directory.localeCompare(b.directory));
    const manifests = new Set(packages.map(pkg => pkg.manifest));
    const unmodeledManifests = context.files.filter(file => /(?:^|\/)Cargo\.toml$/.test(file)
      && file !== "Cargo.toml" && !manifests.has(file));
    // Cargo metadata resolves every path dependency (all features, all platforms), so when no local
    // package outside the workspace appears, no member depends on these crates: they are fixtures or
    // excluded crates. Their files stay unmodelled, so changing one keeps the full suite (impact.ts)
    // without blocking changes elsewhere. Otherwise the repository-wide fallback stays.
    const localDependencyOutside = metadata.packages.some(pkg => !metadata.workspace_members.includes(pkg.id) && (pkg.source === undefined || pkg.source === null));
    const unmodeledBoundary = (file: string) => !localDependencyOutside
      && unmodeledManifests.some(manifest => under(file, manifest.slice(0, -"/Cargo.toml".length)));
    if (unmodeledManifests.length && localDependencyOutside) result.blockers.push(`Cargo manifests outside workspace membership require full validation: ${unmodeledManifests.join(", ")}`);
    if (manifests.size !== packages.length) result.blockers.push("Cargo packages share a manifest; ownership is ambiguous");
    const owner = (file: string) => {
      const candidate = packages.find(pkg => under(file, pkg.directory));
      if (!candidate || unmodeledManifests.some(manifest => {
        const boundary = manifest.slice(0, -"/Cargo.toml".length);
        return boundary.length > candidate.directory.length && under(file, boundary);
      })) return undefined;
      return candidate;
    };
    for (const file of context.files.filter(file => file.endsWith(".rs"))) {
      if (!owner(file) && unmodeledBoundary(file)) continue;
      if (!owner(file) || !repositoryPath(root, resolve(root, file), known)) {
        result.blockers.push(`Rust file has no verified Cargo package: ${file}`);
      } else result.sourcePaths.push(file);
    }
    result.rustTestTargets = {};
    const buildScriptCrates = new Set<string>();
    for (const { pkg } of packages) {
      for (const target of pkg.targets) {
        const path = repositoryPath(root, target.src_path, known);
        if (!path || owner(path)?.pkg.id !== pkg.id) {
          result.blockers.push(`Rust target ${pkg.name}/${target.name} has an unavailable, external or differently owned source`);
          continue;
        }
        if (!path.endsWith(".rs")) result.blockers.push(`Cargo target with a non-Rust extension requires full validation: ${path}`);
        if (target.kind.includes("custom-build")) {
          // The build script is the crate's own source; what it reads is modelled below.
          result.sourcePaths.push(path);
          buildScriptCrates.add(pkg.id);
          (result.rustDocumentationReaders ??= []).push(path);
          continue;
        }
        const kind = target.kind.includes("test") ? "test"
          : target.kind.includes("bin") ? "bin"
          : target.kind.includes("example") ? "example"
          : target.kind.includes("bench") ? "bench"
          : target.kind.some(kind => ["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"].includes(kind)) ? "lib" : undefined;
        if (!kind) {
          result.blockers.push(`Unsupported Cargo target kind: ${pkg.name}/${target.name}`);
          continue;
        }
        result.sourcePaths.push(path);
        // Cargo's test/doctest flags are authoritative. A crate's lib/bin root
        // represents its unit tests, including #[cfg(test)] modules in other files.
        if ((!target.test && !target.doctest) || !tested.has(pkg.id)) continue;
        if (Object.hasOwn(result.rustTestTargets, path)) {
          result.blockers.push(`Multiple Cargo test targets share a source path: ${path}`);
          continue;
        }
        result.testFiles.push(path);
        result.testPackages[path] = spec(pkg);
        // Plain `cargo test` builds and runs a target with `required-features` only when Cargo enabled
        // those features for its package, and skips it silently otherwise. The planner keeps such a
        // package whole (`-p name`, never `--test name`), so Cargo makes the same decision for the
        // selected command as for the full run: the feature check below gives the package the full
        // run's features.
        const requiredFeatures = target["required-features"]?.length ? [...target["required-features"]].sort() : undefined;
        result.rustTestTargets[path] = { name: target.name, kind, ...(requiredFeatures ? { requiredFeatures } : {}) };
      }
    }
    const moduleTrees = packages.flatMap(({ pkg }) => pkg.targets.map(target => resolvedPath(root, target.src_path)))
      .filter((path): path is string => path !== undefined).map(path => dirname(path) === "." ? "" : dirname(path));
    if (!completeRustInventory(root, known, moduleTrees)) result.blockers.push("Incomplete Rust source inventory or symlinked inputs require full validation");
    result.sourcePaths = [...new Set(result.sourcePaths)].sort();
    result.testFiles.sort();
    if (!result.testFiles.length) result.blockers.push("Cargo metadata found no supported test targets");
    const anchors = new Map(packages.map(({ pkg, manifest }) => [pkg.id, manifest]));
    // A parent crate can load Rust modules from a nested package directory
    // without a Cargo dependency declaration. Keep that containment edge rather
    // than assuming deepest ownership proves the parent never reads the child.
    for (const parent of packages) for (const child of packages) {
      if (parent !== child && under(child.manifest, parent.directory)) result.edges.push({ from: parent.manifest, to: child.manifest, kind: "import" });
    }
    for (const file of result.sourcePaths) {
      const anchor = owner(file)?.manifest;
      if (anchor && anchor !== file) result.edges.push({ from: anchor, to: file, kind: "import" }, { from: file, to: anchor, kind: "import" });
    }
    // Cargo resolves all target platforms unless --filter-platform is supplied.
    // --all-features below unions optional dependencies too; cfg(feature) code
    // stays crate-granular and does not itself make the graph unsafe.
    const nodes = metadata.resolve?.nodes;
    const packageIds = new Set(metadata.packages.map(pkg => pkg.id));
    if (!Array.isArray(nodes) || nodes.some(node => !object(node) || typeof node.id !== "string"
      || !packageIds.has(node.id) || !strings(node.dependencies) || node.dependencies.some(id => !packageIds.has(id)))
      || new Set(nodes.map(node => node.id)).size !== nodes.length
      || metadata.workspace_members.some(id => !nodes.some(node => node.id === id))) {
      result.blockers.push("Cargo dependency resolution is missing or incomplete; full validation required");
    } else {
      for (const node of nodes) {
        const anchor = anchors.get(node.id);
        if (!anchor) continue;
        for (const dependency of node.dependencies) {
          const target = anchors.get(dependency);
          if (target && target !== anchor) result.edges.push({ from: anchor, to: target, kind: "import" });
        }
      }
    }
    // Registry and Git dependencies are locked and immutable unless Cargo.lock changes, and a
    // Cargo.lock change keeps the full suite. Their build scripts and procedural macros run the same
    // code for the selected and the full invocation; anything they read from this repository outside
    // modelled Rust sources is a changed path that keeps the full suite. A local path dependency that
    // is not a workspace member has no modelled ownership, so it still blocks the repository.
    const localOutside = metadata.packages.filter(pkg => !metadata.workspace_members.includes(pkg.id) && (pkg.source === undefined || pkg.source === null));
    if (localOutside.length) {
      result.blockers.push(`Local Cargo path dependencies outside the workspace require full validation: ${localOutside.map(pkg => pkg.name).sort().join(", ")}`);
    }
    // A workspace crate's build script can read any file. Its own source and every non-Rust input
    // are already full-suite changes; what remains is another crate's Rust source or manifest, so
    // such a crate depends on every workspace crate: it and its dependents run for any Rust change,
    // while crates without build scripts still narrow.
    for (const id of buildScriptCrates) {
      const anchor = anchors.get(id)!;
      for (const other of packages) if (other.manifest !== anchor) result.edges.push({ from: anchor, to: other.manifest, kind: "import" });
    }
    for (const source of result.sourcePaths.filter(path => path.endsWith(".rs"))) {
      const sourceOwner = owner(source);
      if (!sourceOwner) continue;
      const scanned = rustInputs(readFileSync(resolve(root, source), "utf8"));
      if (scanned === undefined) {
        result.blockers.push(`Rust computed includes or path attributes require full validation: ${source}`);
        continue;
      }
      // Code that runs Cargo or rustc can build any workspace crate; a literal path can reach another
      // crate's sources at run or build time (relative to the crate, as under `cargo test`, or to the
      // file). Code that climbs out of its crate in code can reach any crate, like code that compiles.
      // Model these as dependencies of this crate instead of blocking the repository.
      if (scanned.documentation) (result.rustDocumentationReaders ??= []).push(source);
      if (scanned.runsPrograms) result.rustRunsPrograms = true;
      const reached = new Set<string>();
      if (scanned.compiles || scanned.navigates) for (const other of packages) reached.add(other.manifest);
      for (const literal of scanned.paths) {
        const clean = literal.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/+/, "");
        const glob = clean.search(/[*?[{]/);
        const prefix = glob < 0 ? clean : clean.slice(0, clean.lastIndexOf("/", glob) + 1);
        for (const base of new Set([sourceOwner.directory, dirname(source) === "." ? "" : dirname(source)])) {
          const joined = posix.normalize(posix.join(base || ".", prefix || "."));
          if (joined === ".." || joined.startsWith("../")) continue;
          const rel = joined === "." ? "" : joined.replace(/\/+$/, "");
          const inside = rel ? owner(rel) ?? owner(`${rel}/`) : packages.find(pkg => pkg.directory === "");
          if (inside) reached.add(inside.manifest);
          for (const other of packages) if (other.directory && (rel === "" || under(other.directory, rel) || other.directory === rel)) reached.add(other.manifest);
        }
      }
      reached.delete(sourceOwner.manifest);
      for (const manifest of reached) result.edges.push({ from: sourceOwner.manifest, to: manifest, kind: "import" });
      for (const input of scanned.inputs) {
        const path = repositoryPath(root, resolve(root, dirname(source), input.path), known);
        if (!path || owner(path)?.pkg.id !== sourceOwner.pkg.id) {
          result.blockers.push(`Rust include outside its crate or unavailable requires full validation: ${source}`);
          continue;
        }
        if (input.code && !path.endsWith(".rs")) {
          result.blockers.push(`Rust include code with a non-Rust extension requires full validation: ${source}`);
          continue;
        }
        if (!result.sourcePaths.includes(path)) result.assetPaths.push(path);
        result.edges.push({ from: source, to: path, kind: "asset" });
      }
    }
    result.assetPaths = [...new Set(result.assetPaths)].sort();
    result.rustCrateDirectories = [...new Set(packages.map(({ directory }) => directory))].sort();
    result.rustRunsPrograms ??= false;
    // Selective commands must give every package the features the full invocation gives it. Cargo
    // resolves each tested crate alone and with its dependents (what a change to it selects); the
    // planner checks each selected set against those units.
    if (!cargoFeaturesVary(metadata)) result.rustFeatureCoverage = { deficits: {}, units: [] };
    else {
      const testedNames = packages.filter(({ pkg }) => tested.has(pkg.id)).map(({ pkg }) => spec(pkg));
      const dependents = new Map<string, string[]>();
      for (const edge of result.edges) {
        if (edge.from.endsWith("Cargo.toml") && edge.to.endsWith("Cargo.toml") && edge.from !== edge.to) {
          dependents.set(edge.to, [...(dependents.get(edge.to) ?? []), edge.from]);
        }
      }
      const byManifest = new Map(packages.map(({ pkg, manifest }) => [manifest, spec(pkg)]));
      const units = new Map<string, string[]>();
      for (const { pkg, manifest } of packages) {
        if (tested.has(pkg.id)) units.set(spec(pkg), [spec(pkg)]);
        const seen = new Set([manifest]); const pending = [manifest];
        while (pending.length) for (const next of dependents.get(pending.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); pending.push(next); }
        const closure = [...seen].map(path => byManifest.get(path)).filter((name): name is string => name !== undefined && testedNames.includes(name)).sort();
        if (closure.length) units.set(closure.join(" "), closure);
      }
      const evidence = resolveFeatures?.([...units.values()]);
      const coverage = evidence && rustFeatureCoverage(evidence, testedNames);
      if (coverage) result.rustFeatureCoverage = coverage;
      else result.blockers.push("Cargo feature resolution is unavailable; full validation required");
    }
  } catch {
    result.blockers.push("Invalid or incomplete Cargo metadata requires full validation");
  }
  return result;
}

/** Ask Cargo how it resolves features for the full invocation and for sets of tested crates.
 * Read-only and offline like `cargo metadata`; any failure leaves the evidence missing. */
function cargoFeatureResolver(repoPath: string): CargoFeatureResolver {
  return (units) => {
    if (units.length > 400) return undefined;
    try {
      const tree = (extra: string[]) => execFileSync("cargo", [...CARGO_TREE_ARGS, ...extra], {
        cwd: repoPath, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
      });
      return { workspace: tree([]), units: units.map(crates => ({ crates, tree: tree(crates.flatMap(name => ["-p", name])) })) };
    } catch { return undefined; }
  };
}

/** Configuration keys that change how crates are compiled, which code is compiled or what runs the
 * tests. Aliases, registries, network, terminal, `[env]` and target-dir settings apply equally to
 * the selected and the full invocation, so they do not block. */
const BUILD_CONFIG = /^\s*(?:build\s*\.\s*)?(?:rustflags|rustdocflags|target|rustc|rustdoc|rustc-wrapper|rustc-workspace-wrapper)\s*=|^\s*\[\s*(?:target|patch|unstable)\b|^\s*(?:target|patch|unstable)\s*\.|^\s*(?:paths|include)\s*=|^\s*(?:build|patch|unstable)\s*=/m;
const COMPILER_ENVIRONMENT = /^(?:RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUST(?:DOC)?FLAGS|CARGO_BUILD_RUST(?:DOC)?FLAGS|CARGO_BUILD_TARGET|RUSTC|RUSTDOC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?|CARGO_BUILD_RUSTDOC|CARGO_TARGET_.+_(?:RUNNER|RUSTFLAGS))$/;

/** TOML spells the same key bare, quoted (`"build".rustflags`) or as an inline table
 * (`build = { rustflags = [...] }`); Cargo reads them all. Unquote simple keys before matching, and
 * treat a whole `build`, `patch` or `unstable` inline table as build-changing. */
function changesBuild(path: string): boolean {
  try { return BUILD_CONFIG.test(readFileSync(path, "utf8").replace(/(["'])([A-Za-z0-9_-]+)\1/g, "$2")); }
  catch { return existsSync(path); }
}

/** Every configuration file Cargo reads for a command run at the repository root: the root and each
 * parent directory's `.cargo/config(.toml)`, then `$CARGO_HOME/config(.toml)`. */
function cargoConfigLocations(repoPath: string): string[] {
  const directories: string[] = [];
  let directory = resolve(repoPath);
  try { directory = realpathSync(directory); } catch { /* metadata reports the missing root */ }
  for (;;) {
    directories.push(resolve(directory, ".cargo"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  directories.push(process.env.CARGO_HOME || resolve(homedir(), ".cargo"));
  return directories.flatMap(home => [resolve(home, "config"), resolve(home, "config.toml")]).filter(path => existsSync(path));
}

export const rustAdapter: RepositoryAdapter = {
  id: "rust", version: "2", kind: "language",
  detect: ({ files }) => files.some(file => /(?:^|\/)Cargo\.toml$/.test(file) || file.endsWith(".rs")),
  analyze(context) {
    const failure = contribution(this);
    if (!context.files.includes("Cargo.toml")) {
      failure.blockers.push("Rust support requires a root Cargo.toml");
      return failure;
    }
    const configs = [...context.files.filter(file => /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(file)).map(file => resolve(context.repoPath, file)),
      ...cargoConfigLocations(context.repoPath)];
    if (configs.some(changesBuild)
      || Object.entries(process.env).some(([key, value]) => value && COMPILER_ENVIRONMENT.test(key))) {
      failure.blockers.push("Custom Cargo configuration or compiler environment requires full validation");
      return failure;
    }
    try {
      // No compilation, build scripts or tests. Offline + locked prevents
      // dependency downloads and changes to the repository's Cargo.lock;
      // rustup must not install a missing toolchain on this read-only path.
      const output = execFileSync("cargo", ["metadata", "--format-version", "1", "--all-features", "--offline", "--locked"], {
        cwd: context.repoPath, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
      });
      return analyzeRustMetadata(context, output, cargoFeatureResolver(context.repoPath));
    } catch {
      failure.blockers.push("Cargo metadata unavailable: install Rust and repository dependencies; offline, locked metadata must succeed");
      return failure;
    }
  },
};
