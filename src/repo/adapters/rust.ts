import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  manifest_path: string;
  targets: CargoTarget[];
  source?: string | null;
  dependencies?: Array<{ name: string; features: string[]; uses_default_features: boolean }>;
  features?: Record<string, string[]>;
}

export interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members: string[];
  workspace_root: string;
  resolve?: { nodes: Array<{ id: string; dependencies: string[] }> } | null;
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
      || (pkg.source !== undefined && pkg.source !== null && typeof pkg.source !== "string")) {
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
  return value as unknown as CargoMetadata;
}

function internalPath(root: string, path: string): string | undefined {
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel;
}

/** Refuse symlink escapes as well as lexical escapes before using a metadata path. */
function repositoryPath(root: string, path: string, known: ReadonlySet<string>): string | undefined {
  const rel = internalPath(root, path);
  if (!rel || !known.has(rel)) return undefined;
  try {
    return internalPath(realpathSync(root), realpathSync(path)) === undefined ? undefined : rel;
  } catch { return undefined; }
}

function under(path: string, directory: string): boolean {
  return directory === "" || path.startsWith(`${directory}/`);
}

/** Cargo modules can live under names other adapters exclude. Never silently
 * omit their contents or follow a symlink that aliases another crate's inputs. */
function completeRustInventory(root: string, files: ReadonlySet<string>): boolean {
  const pending = [""];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      if (++entries > 50_000) return false;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name === ".git" || path === "target") continue;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && path.endsWith(".rs") && !files.has(path)) return false;
    }
  }
  return true;
}

/** A small lexer, not a Rust parser: ignore comments/strings, but never guess
 * a computed include. Nested comments and raw strings must not hide an input. */
function rustInputs(source: string): Array<{ path: string; code: boolean }> | undefined {
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
    const raw = /^r(#{0,255})"/.exec(source.slice(i));
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
  // Runtime reads are not Cargo dependency edges, including reads of another
  // crate's otherwise-modelled source. Reject known filesystem/process/FFI
  // access before the changed-path ownership guard can hide that uncertainty.
  const runtimeInputs = new Set(["fs", "File", "OpenOptions", "DirEntry", "ReadDir", "Command", "process", "extern", "unsafe",
    "read_dir", "read_link", "read_to_string", "canonicalize", "metadata", "symlink_metadata", "try_exists", "exists", "is_file", "is_dir"]);
  if (tokens.some(token => runtimeInputs.has(token.value))) return undefined;
  const inputs: Array<{ path: string; code: boolean }> = [];
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
    if (!["include", "include_str", "include_bytes"].includes(tokens[i]!.value)) continue;
    if (tokens[i + 1]?.value !== "!") {
      // Re-exported/renamed builtins could otherwise be called under a name we
      // cannot recognize in another source file.
      if (tokens.some(token => token.value === "use")) return undefined;
      continue;
    }
    const close = new Map([["(", ")"], ["[", "]"], ["{", "}"]]).get(tokens[i + 2]?.value ?? "");
    const literal = tokens[i + 3]?.literal;
    let end = i + 4;
    if (tokens[end]?.value === ",") end++;
    if (!close || literal === undefined || tokens[end]?.value !== close || /[\0\r\n\\]/.test(literal)) return undefined;
    inputs.push({ path: literal, code: tokens[i]!.value === "include" });
  }
  return inputs;
}

export function analyzeRustMetadata(context: AdapterContext, output: string): AdapterContribution {
  const result = contribution(rustAdapter);
  if (context.files.some(file => /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(file))) {
    result.blockers.push("Custom Cargo configuration requires full validation");
  }
  try {
    const metadata = parseCargoMetadata(output);
    const root = resolve(context.repoPath);
    if (realpathSync(metadata.workspace_root) !== realpathSync(root)) {
      result.blockers.push("Rust support requires a Cargo workspace or crate at the repository root");
      return result;
    }
    const known = new Set(context.files);
    if (!completeRustInventory(root, known)) result.blockers.push("Incomplete Rust source inventory or symlinked inputs require full validation");
    const members = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
    if (new Set(members.map(pkg => pkg.name)).size !== members.length) {
      result.blockers.push("Ambiguous Cargo workspace package names require full validation");
      return result;
    }
    const packages: Array<{ pkg: CargoPackage; directory: string; manifest: string }> = [];
    for (const pkg of members) {
      const manifest = repositoryPath(root, pkg.manifest_path, known);
      if (!manifest || !/(?:^|\/)Cargo\.toml$/.test(manifest)) {
        result.blockers.push(`Rust package ${pkg.name} has an unavailable or external manifest`);
        continue;
      }
      packages.push({ pkg, manifest, directory: internalPath(root, dirname(pkg.manifest_path))! });
      result.sourcePaths.push(manifest);
    }
    // Deepest package wins, regardless of Cargo's package ordering.
    packages.sort((a, b) => b.directory.length - a.directory.length || a.directory.localeCompare(b.directory));
    const manifests = new Set(packages.map(pkg => pkg.manifest));
    const unmodeledManifests = context.files.filter(file => /(?:^|\/)Cargo\.toml$/.test(file)
      && file !== "Cargo.toml" && !manifests.has(file));
    if (unmodeledManifests.length) result.blockers.push(`Cargo manifests outside workspace membership require full validation: ${unmodeledManifests.join(", ")}`);
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
      if (!owner(file) || !repositoryPath(root, resolve(root, file), known)) {
        result.blockers.push(`Rust file has no verified Cargo package: ${file}`);
      } else result.sourcePaths.push(file);
    }
    result.rustTestTargets = {};
    for (const { pkg } of packages) {
      for (const target of pkg.targets) {
        const path = repositoryPath(root, target.src_path, known);
        if (!path || owner(path)?.pkg.id !== pkg.id) {
          result.blockers.push(`Rust target ${pkg.name}/${target.name} has an unavailable, external or differently owned source`);
          continue;
        }
        if (!path.endsWith(".rs")) result.blockers.push(`Cargo target with a non-Rust extension requires full validation: ${path}`);
        if (target.kind.includes("custom-build")) continue;
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
        if (!target.test && !target.doctest) continue;
        if (Object.hasOwn(result.rustTestTargets, path)) {
          result.blockers.push(`Multiple Cargo test targets share a source path: ${path}`);
          continue;
        }
        result.testFiles.push(path);
        result.testPackages[path] = pkg.name;
        result.rustTestTargets[path] = { name: target.name, kind };
      }
    }
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
    if (metadata.packages.some(pkg => !metadata.workspace_members.includes(pkg.id))) {
      result.blockers.push("Cargo dependencies outside the workspace have opaque runtime inputs; full validation required");
    }
    // The metadata graph unions all features for edges, but selective commands
    // must preserve the full suite's feature unification. A different selected
    // workspace member can enable a shared dependency's features. Until that
    // execution context is reproduced, forwarded/default-disabled features
    // retain the full original invocation rather than silently dropping tests.
    if (metadata.packages.some(pkg => pkg.dependencies?.some(dep => dep.features.length || !dep.uses_default_features)
      || Object.values(pkg.features ?? {}).some(features => features.some(feature => feature.includes("/"))))) {
      result.blockers.push("Cargo dependency feature unification requires the full workspace test invocation");
    }
    if (metadata.packages.some(pkg => pkg.targets.some(target => target.kind.includes("custom-build")))
      || context.files.some(file => /(?:^|\/)build\.rs$/.test(file))) {
      result.blockers.push("Cargo build scripts can read arbitrary inputs; full validation required");
    }
    if (metadata.packages.some(pkg => pkg.targets.some(target => target.kind.includes("proc-macro")))) {
      result.blockers.push("Cargo procedural macros can read arbitrary inputs; full validation required");
    }
    if (packages.some(({ pkg }) => pkg.targets.some(target => target["required-features"]?.length))) {
      result.blockers.push("Cargo targets requiring features need an explicitly supported test invocation; full validation required");
    }
    for (const source of result.sourcePaths.filter(path => path.endsWith(".rs"))) {
      const sourceOwner = owner(source);
      if (!sourceOwner) continue;
      const inputs = rustInputs(readFileSync(resolve(root, source), "utf8"));
      if (inputs === undefined) {
        result.blockers.push(`Rust runtime inputs, computed includes or path attributes require full validation: ${source}`);
        continue;
      }
      for (const input of inputs) {
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
  } catch {
    result.blockers.push("Invalid or incomplete Cargo metadata requires full validation");
  }
  return result;
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
    if (context.files.some(file => /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(file))
      || existsSync(resolve(context.repoPath, ".cargo/config")) || existsSync(resolve(context.repoPath, ".cargo/config.toml"))
      || Object.entries(process.env).some(([key, value]) => value && /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?|CARGO_TARGET_.+_(?:RUNNER|RUSTFLAGS))$/.test(key))) {
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
      return analyzeRustMetadata(context, output);
    } catch {
      failure.blockers.push("Cargo metadata unavailable: install Rust and repository dependencies; offline, locked metadata must succeed");
      return failure;
    }
  },
};
