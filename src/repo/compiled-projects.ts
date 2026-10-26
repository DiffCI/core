// SPDX-License-Identifier: MIT
/**
 * Tests that observe code by compiling it (2026-10-21).
 *
 * WHY. A test can check a TypeScript project without importing any of it, by running the compiler on
 * a named project and then executing the output: `execFileSync(node, [".../typescript/bin/tsc", "-p",
 * "tsconfig.client.json"])`, then spawning the built CLI. The dependency graph has no edge from such a
 * test to the files it compiles, so a change that breaks the build selected nothing that would notice.
 * Replaying a dogfood repository's history found exactly this: a change to `src/client/cli.ts`
 * selected 117 tests and left out the one that builds and runs the CLI.
 *
 * THE RULE. A test that both invokes the compiler (tsc, typescript/bin/tsc, createProgram, --project)
 * and names a `tsconfig*.json` that exists at HEAD compiles that project. The project is its root files
 * (`files`, `include` and `exclude`, inherited through `extends` when absent) and everything those
 * roots import, which is what tsc compiles too. A change to any of those files selects the test.
 *
 * Over-inclusion is the safe direction: a test that merely writes a tsconfig.json fixture and calls
 * createProgram on a temporary repository is also treated as compiling the real project.
 */
import { posix } from "node:path";
import ts from "typescript";
import { referencePattern, referenceTokens } from "./file-references.js";
import { matchesGlob } from "./test-discovery.js";

const COMPILER_INVOCATION = /["'`/\s]tsc(?:\.cmd)?["'`\s]|typescript["'`/,\s]+bin["'`/,\s]+tsc|\bcreateProgram\b|--project\b|["'`]-p["'`]/;
const PROJECT_CONFIG = /(?:^|\/)tsconfig[^/]*\.json$/;
const COMPILABLE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

export interface CompiledProjectInput {
  files: readonly string[];
  read: (path: string) => string | undefined;
  isTestFile: (path: string) => boolean;
  /** Every file a root transitively imports, from the dependency graph. */
  dependenciesOf: (path: string) => readonly string[];
}

export interface CompiledProject {
  config: string;
  tests: string[];
  files: ReadonlySet<string>;
}

interface RootSpec { files?: string[]; include?: string[]; exclude?: string[]; allowJs?: boolean }

function readSpec(config: string, read: CompiledProjectInput["read"], depth = 0): RootSpec | undefined {
  const text = read(config);
  if (text === undefined || depth > 5) return undefined;
  const parsed = ts.parseConfigFileTextToJson(config, text);
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") return undefined;
  const json = parsed.config as { files?: unknown; include?: unknown; exclude?: unknown; extends?: unknown; compilerOptions?: { allowJs?: unknown } };
  const dir = posix.dirname(config);
  const local = (values: unknown) => Array.isArray(values) ? values.filter((v): v is string => typeof v === "string").map((v) => posix.normalize(posix.join(dir, v))) : undefined;
  let spec: RootSpec = { files: local(json.files), include: local(json.include), exclude: local(json.exclude), allowJs: json.compilerOptions?.allowJs === true ? true : undefined };
  const parents = typeof json.extends === "string" ? [json.extends] : Array.isArray(json.extends) ? json.extends.filter((e): e is string => typeof e === "string") : [];
  for (const parent of parents) {
    if (!parent.startsWith(".")) continue;
    const parentPath = posix.normalize(posix.join(dir, parent.endsWith(".json") ? parent : `${parent}.json`));
    const inherited = readSpec(parentPath, read, depth + 1);
    if (!inherited) continue;
    spec = { files: spec.files ?? inherited.files, include: spec.include ?? inherited.include, exclude: spec.exclude ?? inherited.exclude, allowJs: spec.allowJs ?? inherited.allowJs };
  }
  return spec;
}

function asGlob(pattern: string): string {
  if (/[*?]/.test(pattern) || posix.extname(pattern)) return pattern;
  return `${pattern.replace(/\/$/, "")}/**/*`;
}

/** Root files of a project, as tsc would list them before following imports. */
export function projectRoots(config: string, input: Pick<CompiledProjectInput, "files" | "read">): string[] | undefined {
  const spec = readSpec(config, input.read);
  if (!spec) return undefined;
  const dir = posix.dirname(config);
  const roots = new Set(spec.files ?? []);
  const include = spec.include ?? (spec.files ? [] : [posix.join(dir, "**/*")]);
  const exclude = (spec.exclude ?? []).map(asGlob);
  const extensions = spec.allowJs ? COMPILABLE : /\.(?:[cm]?tsx?)$/;
  for (const pattern of include.map(asGlob)) {
    for (const file of input.files) {
      if (!extensions.test(file) || file.endsWith(".d.ts") || file.split("/").includes("node_modules")) continue;
      if (matchesGlob(file, pattern) && !exclude.some((glob) => matchesGlob(file, glob))) roots.add(file);
    }
  }
  return [...roots].sort();
}

/** Projects that some test compiles, with the tests and every file each compiles. */
export function compiledProjects(input: CompiledProjectInput): CompiledProject[] {
  const configs = input.files.filter((file) => PROJECT_CONFIG.test(file));
  if (configs.length === 0) return [];
  const compilingTests = input.files.filter((file) => input.isTestFile(file) && COMPILABLE.test(file))
    .map((file) => ({ file, text: input.read(file) ?? "" }))
    .filter(({ text }) => COMPILER_INVOCATION.test(text));
  const projects: CompiledProject[] = [];
  for (const config of configs) {
    const names = referencePattern(referenceTokens(config, { ancestors: false }));
    const tests = compilingTests.filter(({ text }) => names.test(text)).map(({ file }) => file);
    if (tests.length === 0) continue;
    const roots = projectRoots(config, input);
    if (!roots) continue;
    const files = new Set<string>(roots);
    for (const root of roots) for (const dependency of input.dependenciesOf(root)) files.add(dependency);
    files.add(config);
    projects.push({ config, tests: tests.sort(), files });
  }
  return projects;
}
