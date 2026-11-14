import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { contribution, type AdapterContext, type AdapterContribution, type RepositoryAdapter } from "./types.js";

export interface CargoTarget {
  name: string;
  kind: string[];
  src_path: string;
  test: boolean;
  doctest: boolean;
}

export interface CargoPackage {
  id: string;
  name: string;
  manifest_path: string;
  targets: CargoTarget[];
}

export interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members: string[];
  workspace_root: string;
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
      || !isAbsolute(pkg.manifest_path) || !Array.isArray(pkg.targets) || !pkg.targets.length) {
      throw new Error("Invalid Cargo package metadata");
    }
    for (const target of pkg.targets) {
      if (!object(target) || typeof target.name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(target.name)
        || !strings(target.kind) || !target.kind.length || typeof target.src_path !== "string"
        || !isAbsolute(target.src_path) || typeof target.test !== "boolean" || typeof target.doctest !== "boolean") {
        throw new Error("Invalid Cargo target metadata");
      }
    }
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

export function analyzeRustMetadata(context: AdapterContext, output: string): AdapterContribution {
  const result = contribution(rustAdapter);
  // This first milestone only establishes ownership. Keep it fail-closed until
  // workspace dependency edges are added, even if called before registration.
  result.blockers.push("Rust crate dependency analysis is not available; full validation required");
  try {
    const metadata = parseCargoMetadata(output);
    const root = resolve(context.repoPath);
    if (realpathSync(metadata.workspace_root) !== realpathSync(root)) {
      result.blockers.push("Rust support requires a Cargo workspace or crate at the repository root");
      return result;
    }
    const known = new Set(context.files);
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
  } catch {
    result.blockers.push("Invalid or incomplete Cargo metadata requires full validation");
  }
  return result;
}

export const rustAdapter: RepositoryAdapter = {
  id: "rust", version: "1", kind: "language",
  detect: ({ files }) => files.some(file => /(?:^|\/)Cargo\.toml$/.test(file) || file.endsWith(".rs")),
  analyze(context) {
    const failure = contribution(this);
    if (!context.files.includes("Cargo.toml")) {
      failure.blockers.push("Rust support requires a root Cargo.toml");
      return failure;
    }
    try {
      // Metadata does not execute repository code. Offline + locked prevents
      // dependency downloads and changes to the repository's Cargo.lock.
      const output = execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline", "--locked"], {
        cwd: context.repoPath, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      return analyzeRustMetadata(context, output);
    } catch {
      failure.blockers.push("Cargo metadata unavailable: install Rust and repository dependencies; offline, locked metadata must succeed");
      return failure;
    }
  },
};
