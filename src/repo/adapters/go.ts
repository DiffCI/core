import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { contribution, type AdapterContext, type AdapterContribution, type RepositoryAdapter } from "./types.js";

interface GoPackage {
  Dir: string;
  ImportPath: string;
  ForTest?: string;
  Name?: string;
  Standard?: boolean;
  Module?: { Replace?: { Dir?: string } };
  Error?: unknown;
  DepsErrors?: unknown[];
  Incomplete?: boolean;
  GoFiles?: string[];
  IgnoredGoFiles?: string[];
  CgoFiles?: string[];
  TestGoFiles?: string[];
  XTestGoFiles?: string[];
  EmbedFiles?: string[];
  TestEmbedFiles?: string[];
  XTestEmbedFiles?: string[];
  Imports?: string[];
  TestImports?: string[];
  XTestImports?: string[];
  SFiles?: string[];
  SysoFiles?: string[];
}

/** go list emits adjacent JSON objects, not a JSON array or JSONL. */
export function parseGoList(output: string): GoPackage[] {
  const packages: GoPackage[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}") {
      if (--depth < 0) throw new Error("Invalid go list output");
      if (depth === 0) {
        const pkg = JSON.parse(output.slice(start, i + 1)) as GoPackage;
        if (typeof pkg.Dir !== "string" || typeof pkg.ImportPath !== "string") throw new Error("Incomplete Go package metadata");
        packages.push(pkg);
      }
    } else if (depth === 0 && !/\s/.test(c)) throw new Error("Unexpected go list output");
  }
  if (depth || quoted || !packages.length) throw new Error("Truncated or empty go list output");
  return packages;
}

function internalPath(root: string, path: string): string | undefined {
  const rel = relative(root, resolve(path)).replace(/\\/g, "/");
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel;
}

/** go ./... excludes these names; edits still require full CI (for example testdata reads). */
export function isGoDiscoveryIgnoredPath(path: string): boolean {
  return path.split("/").some(part => part === "testdata" || part.startsWith("_") || part.startsWith("."));
}

export function analyzeGoMetadata(context: AdapterContext, output: string): AdapterContribution {
  const result = contribution(goAdapter);
  const all = parseGoList(output);
  if (all.some((pkg) => pkg.Module?.Replace?.Dir && internalPath(context.repoPath, pkg.Module.Replace.Dir) === undefined)) result.blockers.push("Go local module replacement lies outside the repository");
  if (all.some((pkg) => pkg.Error || pkg.Incomplete || pkg.DepsErrors?.length)) result.blockers.push("Go package metadata contains errors");
  const packages = all.filter((pkg) => !pkg.ForTest && !pkg.ImportPath.endsWith(".test") && !pkg.Standard && internalPath(context.repoPath, pkg.Dir) !== undefined);
  const anchors = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const pkg of packages) {
    // Associate inactive files with their package conservatively. They are not runnable
    // tests, but edits (including build constraints) must still select that package and
    // its dependents. Unaccounted files remain a global blocker below.
    const files = [...(pkg.GoFiles ?? []), ...(pkg.CgoFiles ?? []), ...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? []), ...(pkg.IgnoredGoFiles ?? [])];
    const paths = files.map((file) => internalPath(context.repoPath, resolve(pkg.Dir, file)));
    if (paths.some((p) => p === undefined)) { result.blockers.push("Go package contains files outside the repository"); continue; }
    const sources = paths as string[];
    if (!sources.length) continue;
    anchors.set(pkg.ImportPath, sources[0]);
    members.set(pkg.ImportPath, sources);
    result.sourcePaths.push(...sources);
    if (pkg.CgoFiles?.length) result.blockers.push(`Go ${pkg.ImportPath}: cgo dependencies require full validation`);
    if (pkg.SFiles?.length || pkg.SysoFiles?.length) result.blockers.push(`Go ${pkg.ImportPath}: native assembly/object dependencies require full validation`);
    if ([...(pkg.Imports ?? []), ...(pkg.TestImports ?? []), ...(pkg.XTestImports ?? [])].includes("plugin")) result.blockers.push(`Go ${pkg.ImportPath}: runtime plugins require full validation`);
    for (const file of sources) {
      if (/^\s*\/\/go:(?:generate|linkname)\b/m.test(readFileSync(resolve(context.repoPath, file), "utf8"))) result.blockers.push(`Go ${file}: generated or linked dependencies require full validation`);
    }
    const dir = internalPath(context.repoPath, pkg.Dir)!;
    for (const test of [...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])]) {
      const path = internalPath(context.repoPath, resolve(pkg.Dir, test))!;
      result.testFiles.push(path);
      result.testPackages[path] = dir ? `./${dir}` : ".";
    }
    for (const file of [...(pkg.EmbedFiles ?? []), ...(pkg.TestEmbedFiles ?? []), ...(pkg.XTestEmbedFiles ?? [])]) {
      const asset = internalPath(context.repoPath, resolve(pkg.Dir, file));
      if (asset === undefined) { result.blockers.push("Go embedded file escapes repository"); continue; }
      result.assetPaths.push(asset);
      result.edges.push({ from: sources[0], to: asset, kind: "asset" });
    }
  }
  for (const pkg of packages) {
    const anchor = anchors.get(pkg.ImportPath);
    if (!anchor) continue;
    // A package is the selection unit: every member shares package-level dependencies.
    for (const file of members.get(pkg.ImportPath) ?? []) {
      if (file !== anchor) result.edges.push({ from: anchor, to: file, kind: "import" }, { from: file, to: anchor, kind: "import" });
    }
    for (const imported of [...(pkg.Imports ?? []), ...(pkg.TestImports ?? []), ...(pkg.XTestImports ?? [])]) {
      const target = anchors.get(imported);
      if (target && target !== anchor) result.edges.push({ from: anchor, to: target, kind: "import" });
    }
  }
  if (!result.sourcePaths.length) result.blockers.push("Go analysis found no local packages");
  // Ignored files/build tags, generation and testdata can change the runnable universe.
  const modeled = new Set([...result.sourcePaths, ...result.assetPaths]);
  const unmodeled = context.files.filter(file => file.endsWith(".go") && !modeled.has(file) && !isGoDiscoveryIgnoredPath(file));
  if (unmodeled.length) result.blockers.push(`Go files outside the active build context require full validation: ${unmodeled.slice(0, 20).join(", ")}`);
  return result;
}

export const goAdapter: RepositoryAdapter = {
  id: "go", version: "3", kind: "language",
  detect: ({ files }) => files.some((file) => file === "go.mod" || file.endsWith(".go")),
  analyze(context) {
    const failure = contribution(this);
    const nestedRoots = context.files.filter(f => f.endsWith("/go.mod")).map(f => f.slice(0, -"go.mod".length));
    const scoped = context.profile.diffciConfig?.go?.scope === "root-module";
    if (!context.files.includes("go.mod") || context.files.includes("go.work") || (nestedRoots.length && !scoped)) {
      failure.blockers.push("Go support requires one root go.mod; workspaces and nested modules require full validation");
      return failure;
    }
    try {
      const env = { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GOWORK: "off" };
      const buildEnv = JSON.parse(execFileSync("go", ["env", "-json", "GOOS", "GOARCH", "CGO_ENABLED", "GOFLAGS"], {
        cwd: context.repoPath, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
        windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
      })) as Record<string, string>;
      if (["GOOS", "GOARCH", "CGO_ENABLED", "GOFLAGS"].some((key) => typeof buildEnv[key] !== "string") || buildEnv.GOFLAGS.trim()) {
        failure.blockers.push("Go custom build flags or incomplete build context require full validation");
        return failure;
      }
      // No repository code is executed and module manifests must not be modified.
      const output = execFileSync("go", ["list", "-mod=readonly", "-deps", "-test", "-json", "./..."], {
        cwd: context.repoPath, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const excluded = (file: string) => nestedRoots.some(root => file.startsWith(root));
      const scopedContext = scoped ? { ...context, files: context.files.filter(file => !excluded(file)) } : context;
      const result = analyzeGoMetadata(scopedContext, output);
      if (scoped) {
        context.profile.goExcludedModuleRoots = nestedRoots;
        // A local replacement can make an excluded module part of the root module's build.
        if (parseGoList(output).some(pkg => pkg.Module?.Replace?.Dir)) result.blockers.push("Go root-module scope with local replacements requires full validation");
      }
      result.executionEnv = { GOOS: buildEnv.GOOS, GOARCH: buildEnv.GOARCH, CGO_ENABLED: buildEnv.CGO_ENABLED, GOFLAGS: "" };
      return result;
    } catch {
      failure.blockers.push("Go metadata unavailable: install Go and repository dependencies before analysis (go list must succeed offline)");
      return failure;
    }
  },
};
