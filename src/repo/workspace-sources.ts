// SPDX-License-Identifier: MIT
/**
 * Maps an import of a declared workspace package to that package's source files.
 *
 * Workspace packages commonly point `types`, `main` and `exports` at build output (2026-11-09, Sentry's
 * JavaScript SDK: `@sentry/server-utils` exports `./build/types/index.d.ts`). Before a build those files
 * do not exist and the import resolves nowhere; after `build:types` it resolves to a generated declaration
 * file that no source change ever touches. Either way the edge into the package's `src/` is lost, and a
 * selective plan would skip every downstream package.
 *
 * The mapping is exact or absent. A declaration entry maps to source only through a tsconfig in the
 * package root that states both an output directory (`declarationDir` or `outDir`) containing the entry and
 * a `rootDir`; `outDir/x.d.ts` becomes `rootDir/x.ts` (or `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`) when that file
 * exists. An entry that is itself a TypeScript source file is used as is. Anything else is unmapped, and the
 * caller must fall back rather than guess.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import ts from "typescript";

export interface WorkspacePackage {
  name: string;
  /** Repository-relative directory; never the repository root. */
  root: string;
}

/** One tsconfig's emit directories, repository-relative and inside the package. */
interface OutputDirectories {
  declarationDir: string | undefined;
  outDir: string | undefined;
  rootDir: string;
}

const DECLARATION = /\.d\.([mc]?)ts$/;
const SOURCE = /\.([mc]?tsx?|[mc]?jsx?)$/;
const EMITTED = /\.([mc]?)jsx?$/;

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export class WorkspaceSources {
  private readonly packages = new Map<string, WorkspacePackage>();
  private readonly manifests = new Map<string, Record<string, unknown> | undefined>();
  private readonly outputs = new Map<string, OutputDirectories[]>();

  constructor(private readonly repoPath: string, workspaceRoots: Iterable<string>) {
    for (const root of workspaceRoots) {
      if (!root) continue;
      const name = this.manifest(root)?.name;
      if (typeof name === "string" && name && !this.packages.has(name)) this.packages.set(name, { name, root });
    }
  }

  get size(): number {
    return this.packages.size;
  }

  /** The workspace package a bare specifier names, and the export subpath (`.` or `./x`). */
  packageFor(specifier: string): { pkg: WorkspacePackage; subpath: string } | undefined {
    const parts = specifier.split("/");
    const nameParts = specifier.startsWith("@") ? 2 : 1;
    if (parts.length < nameParts || parts.slice(0, nameParts).some((part) => !part)) return undefined;
    const pkg = this.packages.get(parts.slice(0, nameParts).join("/"));
    if (!pkg) return undefined;
    const rest = parts.slice(nameParts).join("/");
    return { pkg, subpath: rest ? `./${rest}` : "." };
  }

  /** Repository-relative source file for an import of `subpath`, from the package manifest. */
  sourceForSubpath(pkg: WorkspacePackage, subpath: string): string | undefined {
    const manifest = this.manifest(pkg.root);
    if (!manifest) return undefined;
    const entry = entryTarget(manifest, subpath);
    if (entry === undefined && subpath !== ".") {
      // A deep import of a file path the manifest does not export, such as Sentry's
      // `@sentry/node/build/types/types` in a type import: map that file itself.
      const file = posix.normalize(posix.join(pkg.root, subpath));
      if (!file.startsWith(`${pkg.root}/`)) return undefined;
      for (const candidate of [file, `${file}.d.ts`, `${file}/index.d.ts`, `${file}.ts`, `${file}/index.ts`]) {
        const source = this.toSource(pkg, candidate);
        if (source) return source;
      }
      return undefined;
    }
    if (!entry || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) return undefined;
    const target = posix.normalize(posix.join(pkg.root, entry));
    if (target !== pkg.root && !target.startsWith(`${pkg.root}/`)) return undefined;
    return this.toSource(pkg, target);
  }

  /** Repository-relative source file for a file inside the package that TypeScript resolved to. */
  sourceForFile(pkg: WorkspacePackage, fileRel: string): string | undefined {
    return this.toSource(pkg, fileRel);
  }

  private toSource(pkg: WorkspacePackage, targetRel: string): string | undefined {
    const declaration = DECLARATION.exec(targetRel);
    const script = declaration ? null : EMITTED.exec(targetRel);
    const outputs = this.outputDirectories(pkg);
    for (const { declarationDir, outDir, rootDir } of outputs) {
      // Declarations live in declarationDir (or outDir); emitted JavaScript only in outDir.
      const directory = declaration ? declarationDir : script ? outDir : undefined;
      if (!directory || !targetRel.startsWith(`${directory}/`)) continue;
      const flavor = (declaration ?? script)![1];
      const stem = targetRel.slice(directory.length + 1).replace(declaration ? DECLARATION : EMITTED, "");
      const extensions = flavor ? [`.${flavor}ts`, `.${flavor}js`] : [".ts", ".tsx", ".js", ".jsx"];
      for (const extension of extensions) {
        const candidate = posix.join(rootDir, stem + extension);
        if (existsSync(join(this.repoPath, candidate))) return candidate;
      }
    }
    if (declaration) return undefined;
    // Build output is never source, even when it exists on disk.
    if (outputs.some(({ declarationDir, outDir }) => [declarationDir, outDir].some((dir) => dir && targetRel.startsWith(`${dir}/`)))) return undefined;
    return SOURCE.test(targetRel) && existsSync(join(this.repoPath, targetRel)) ? targetRel : undefined;
  }

  /** Output directories stated by tsconfig*.json files in the package root, with their rootDir. */
  private outputDirectories(pkg: WorkspacePackage): OutputDirectories[] {
    let found = this.outputs.get(pkg.root);
    if (found) return found;
    found = [];
    const directory = join(this.repoPath, pkg.root);
    let names: string[] = [];
    try {
      names = readdirSync(directory).filter((name) => /^tsconfig(\..+)?\.json$/.test(name)).sort();
    } catch { /* an unreadable package states no outputs */ }
    for (const name of names) {
      const file = toPosix(join(directory, name));
      const read = ts.readConfigFile(file, ts.sys.readFile);
      if (read.error) continue;
      const options = ts.parseJsonConfigFileContent(read.config, ts.sys, toPosix(directory), undefined, file).options;
      const rootDir = this.relative(options.rootDir);
      // Every directory must stay inside the package; a rootDir elsewhere would map onto another package's files.
      const within = (path: string | undefined): path is string => path !== undefined && (path === pkg.root || path.startsWith(`${pkg.root}/`));
      if (!within(rootDir)) continue;
      const usable = (path: string | undefined) => (within(path) && path !== rootDir ? path : undefined);
      const outDir = usable(this.relative(options.outDir));
      const declarationDir = usable(this.relative(options.declarationDir ?? options.outDir));
      if (outDir || declarationDir) found.push({ declarationDir, outDir, rootDir });
    }
    this.outputs.set(pkg.root, found);
    return found;
  }

  private relative(path: string | undefined): string | undefined {
    if (!path) return undefined;
    const root = toPosix(this.repoPath).replace(/\/$/, "");
    const value = posix.normalize(toPosix(path));
    if (value.toLowerCase() === root.toLowerCase()) return "";
    return value.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? value.slice(root.length + 1) : undefined;
  }

  private manifest(root: string): Record<string, unknown> | undefined {
    if (this.manifests.has(root)) return this.manifests.get(root);
    let manifest: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(readFileSync(join(this.repoPath, root, "package.json"), "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
    } catch { /* an unreadable manifest names no package */ }
    this.manifests.set(root, manifest);
    return manifest;
  }
}

/** The entry the manifest gives for `subpath`: the `types` target of its export (or a TypeScript source
 * target when it has none), else the top-level `types`/`typings` for the package root. */
function entryTarget(manifest: Record<string, unknown>, subpath: string): string | undefined {
  const exports = manifest.exports;
  if (exports === undefined) {
    if (subpath !== ".") return undefined;
    const types = manifest.types ?? manifest.typings;
    return typeof types === "string" ? types : undefined;
  }
  const isMap = exports !== null && typeof exports === "object" && !Array.isArray(exports);
  const keyed = isMap && Object.keys(exports).some((key) => key.startsWith("."));
  if (!keyed) return subpath === "." ? pickEntry(exports, undefined) : undefined;
  const map = exports as Record<string, unknown>;
  if (subpath in map) return pickEntry(map[subpath], undefined);
  // Subpath patterns: the longest matching prefix wins, as in Node.
  let best: { key: string; star: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (!best || prefix.length > best.key.indexOf("*")) best = { key, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  return best ? pickEntry(map[best.key], best.star) : undefined;
}

function pickEntry(entry: unknown, star: string | undefined): string | undefined {
  const fill = (value: string) => (star === undefined ? value : value.split("*").join(star));
  const leaves: Array<{ value: string; types: boolean }> = [];
  const walk = (node: unknown, types: boolean) => {
    if (typeof node === "string") leaves.push({ value: fill(node), types });
    else if (Array.isArray(node)) for (const item of node) walk(item, types);
    else if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) walk(value, types || key === "types");
  };
  walk(entry, false);
  return leaves.find((leaf) => leaf.types)?.value
    ?? leaves.find((leaf) => DECLARATION.test(leaf.value))?.value
    ?? leaves.find((leaf) => /\.[mc]?tsx?$/.test(leaf.value))?.value
    // JavaScript only: mapped back through a tsconfig outDir, or used as is when it is source.
    ?? leaves.find((leaf) => EMITTED.test(leaf.value))?.value;
}
