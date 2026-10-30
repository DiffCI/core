// SPDX-License-Identifier: MIT
/**
 * Who reads this file? (2026-10-21, telemetry from two dogfood repositories.)
 *
 * WHY. A changed file that is not code - `site/docs/x.html`, `scripts/train.py`, `ops/.../blockers.json`,
 * `.env.example` - previously meant "Unknown changed file" and a full run. Across 256 verification
 * receipts this was the third most common fallback (76 receipts), and 138 of one repository's unknown files
 * were site HTML whose only readers are two tests. The engine has no import edge for these, because tests
 * reach them through the filesystem: `readFileSync(join(root, "site", ...))`, `readdirSync("fixtures")`,
 * `spawn("python3", ["scripts/train.py"])`.
 *
 * THE RULE. A test suite can only observe a non-code file by naming it, or by naming a directory that
 * contains it. So: collect every text file at HEAD that names the changed file's path, its basename, or
 * one of its ancestor directories as a string, and resolve each reader:
 *
 *   - a test reader is selected;
 *   - a code reader in the dependency graph selects the tests that depend on it;
 *   - a package.json reader counts only when the naming script runs as part of `npm test`;
 *   - a test-running workflow, a composite action or an unparseable package.json is unresolvable;
 *   - documentation names files constantly and executes nothing, so it is never a reader;
 *   - any other file - a shell script, a JSON manifest, or code no test imports (a standalone check
 *     script outside the dependency graph) - may itself be executed or read, so ITS readers are
 *     resolved in turn, to a bounded depth. A test can only run such a file by naming it.
 *
 * FAILING CLOSED. No reader at all, or any unresolvable reader, keeps the file unknown (full run).
 * Evidence of who reads a file is required before anything narrows; the absence of a reference is never
 * treated as proof that nothing reads it. Files that tools load implicitly, without any code naming them
 * (`.gitignore`, `.env`, `tsconfig.json`, `wrangler.toml`, `Dockerfile`), never reach this resolver.
 *
 * RESIDUAL RISK. A reader that computes the path from parts that never appear as strings, or walks the
 * whole repository from its root without naming a directory, is invisible here. Required CI stays
 * authoritative for exactly that reason.
 */
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { matchesGlob } from "./test-discovery.js";

const MAX_READ_BYTES = 1_048_576;

/** Reads repo-relative text files from a checkout at HEAD, the same tree the dependency graph reads.
 * Binary content (a NUL byte in the first 8 KiB) and files over 1 MiB are unreadable. */
const TEXT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|go|java|kt|py|rb|sh|json|jsonc|ya?ml|toml|md|mdx|html?|css|sql|txt)$/i;

export function repositoryFileReader(repoPath: string): (path: string) => string | undefined {
  return (path) => {
    try {
      const full = join(repoPath, path);
      if (statSync(full).size > MAX_READ_BYTES) return undefined;
      const bytes = readFileSync(full);
      // Source and text files are text even when they contain a stray NUL (a separator literal): treating
      // one as binary hid it as a reader and made suiteMayRunWorkers fail closed (2026-10-29).
      if (!TEXT_EXTENSIONS.test(path) && bytes.subarray(0, 8192).includes(0)) return undefined;
      return bytes.toString("utf8");
    } catch {
      return undefined;
    }
  };
}

/** Names tools read without any code naming them. A change to one of these is never reference-resolved. */
const IMPLICIT_BASENAMES = new Set([
  ".gitignore", ".gitattributes", ".gitmodules", ".npmrc", ".yarnrc", ".yarnrc.yml", ".nvmrc", ".node-version",
  ".tool-versions", ".editorconfig", ".browserslistrc", ".babelrc", ".swcrc", ".mocharc", ".c8rc", ".nycrc",
  "makefile", "procfile", "justfile", "taskfile.yml", "compose.yaml", "compose.yml", "turbo.json", "nx.json", "lerna.json",
]);
const IMPLICIT_PREFIXES = ["tsconfig", "jsconfig", "wrangler.", "dockerfile", "docker-compose", ".dockerignore", ".mocharc.", ".c8rc.", ".nycrc.", "babel.config", ".babelrc."];
const ENV_TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist)$/;

/** True when tooling may load `filePath` implicitly, so no reference to it would ever be written. */
export function isImplicitlyLoadedFile(filePath: string): boolean {
  const base = posix.basename(filePath).toLowerCase();
  if (IMPLICIT_BASENAMES.has(base)) return true;
  if (IMPLICIT_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  if (/\.config\.[^.]+$/.test(base)) return true;
  if (base === ".env" || (base.startsWith(".env.") && !ENV_TEMPLATE_SUFFIX.test(base))) return true;
  return /\.(?:tf|tfvars|hcl)$/.test(base);
}

const INFRASTRUCTURE_DIRS = new Set(["ops", "terraform", "cloudformation", "pulumi", "cdktf", "deploy", "deployments", "kubernetes", "k8s", "helm", "docker"]);
const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|go|java|kt)$/i;
const DOCUMENT_EXTENSIONS = /\.(?:md|mdx)$/i;

/**
 * What a file under an infrastructure directory is (2026-10-21). Everything under `ops/` used to force
 * full validation - 55 of one dogfood repository's 124 receipts - yet that tree holds tested Worker code, runbooks
 * and JSON evidence manifests as well as deployment definitions. Only a definition that tooling loads by
 * convention is global; code goes through the dependency graph, Markdown is documentation, and other
 * files are data whose readers are resolved by reference. `undefined` outside infrastructure trees.
 */
export function infrastructureRole(filePath: string): "definition" | "code" | "documentation" | "data" | undefined {
  const base = posix.basename(filePath);
  if (/dockerfile/i.test(base)) return "definition";
  const first = filePath.split("/")[0];
  if (!first || !INFRASTRUCTURE_DIRS.has(first) || !filePath.includes("/")) return undefined;
  if (isImplicitlyLoadedFile(filePath)) return "definition";
  if (CODE_EXTENSIONS.test(base)) return "code";
  if (DOCUMENT_EXTENSIONS.test(base)) return "documentation";
  return "data";
}

interface ReferenceToken { value: string; bare: boolean }

/** The strings whose appearance means a file names `filePath`: the path itself, its basename, and every
 * ancestor directory (as a path and as a name). A bare name (no dot, no slash) must be delimited by
 * quotes or slashes on both sides, so prose and identifiers do not match; anything else may also be
 * delimited by whitespace, as in a shell command line.
 *
 * `ancestors: false` drops the directories. A script is run by naming it, so following who runs a code
 * reader needs only its path and basename; in one dogfood repository the bare `"scripts"` matched nearly every
 * file and no change under `site/` could ever resolve (2026-10-21 replay). */
export function referenceTokens(filePath: string, { ancestors = true }: { ancestors?: boolean } = {}): ReferenceToken[] {
  const tokens = new Map<string, ReferenceToken>();
  const add = (value: string) => { if (value && value !== ".") tokens.set(value, { value, bare: !/[./]/.test(value) }); };
  add(filePath);
  add(posix.basename(filePath));
  let dir = posix.dirname(filePath);
  while (ancestors && dir !== "." && dir !== "/") { add(dir); add(posix.basename(dir)); dir = posix.dirname(dir); }
  return [...tokens.values()];
}

function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** One regular expression matching any of `tokens` at a reference boundary. */
export function referencePattern(tokens: readonly ReferenceToken[]): RegExp {
  const parts = tokens.map(({ value, bare }) => bare
    ? `["'\`/]${escape(value)}(?=["'\`/])`
    : `(?:^|["'\`/\\s=(])${escape(value)}(?=$|["'\`/\\s),;:])`);
  return new RegExp(parts.join("|"), "m");
}

export type ReaderKind = "test" | "graph-code" | "package-script" | "documentation" | "transitive" | "unresolvable";

export interface ReferenceResolutionInput {
  /** Repo-relative paths present at HEAD. */
  files: readonly string[];
  /** Reads a repo-relative file at HEAD; undefined for unreadable, binary or oversized content. */
  read: (path: string) => string | undefined;
  isTestFile: (path: string) => boolean;
  isDocumentation: (path: string) => boolean;
  /** Whether a code file is part of the dependency graph. */
  inGraph: (path: string) => boolean;
  isCodeFile: (path: string) => boolean;
  /** Whether something a workflow names can reach the test suite through it, given a pattern matching
   * the name (src/repo/workflow-test-steps.ts, workflowFeedsTests). */
  workflowFeedsTests: (content: string, names: RegExp) => boolean;
  /** Changed files whose content analyzeGitDelta proved cannot change how tests run
   * (GitDeltaAnalysis.referenceResolvedPaths); a workflow reading them does not block. */
  contentCleared?: ReadonlySet<string>;
  /** The caller has independently modeled this file's implicit effects (e.g. lockfile dependencies).
   * No explicit reader is then acceptable, but every potential reader must be readable and every
   * reader found must still resolve. Defaults to false. */
  allowNoReaders?: boolean;
  /** No code in the repository runs a Worker (suiteMayRunWorkers is false), so a wrangler config with
   * no reader is outside the suite. */
  workerConfigsOutsideSuite?: boolean;
  /** Treat a reader that tooling loads implicitly (wrangler config, Dockerfile, `*.config.*`) as
   * unresolvable. Used for code: such a reader can run the file without anything naming it. */
  implicitReadersUnresolvable?: boolean;
  /** Resolve a file the root test script runs directly (`node scripts/test-security.js`) to that phase
   * of the script instead of failing closed (ReferenceResolution.phases). Off by default: a caller
   * that does not run the returned phases must keep the fallback. */
  testPhases?: boolean;
}

export interface ReferenceResolution {
  /** Tests that name the file, directly or through a chain of non-code readers. */
  tests: string[];
  /** Graph code that names the file; its dependent tests are selected by the caller. */
  code: string[];
  /** Why the file cannot be narrowed; empty when it can. */
  unresolvable: string[];
  /** Every reader found, for evidence. */
  readers: Array<{ path: string; kind: ReaderKind; via: string }>;
  /** Phases of the root test script, verbatim, that run a reader directly; the caller must run them.
   * Only produced with `testPhases`. */
  phases: string[];
}

const MAX_DEPTH = 5;
const MAX_TRANSITIVE_READERS = 50;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"]);
const TEST_LIFECYCLE = ["pretest", "test", "posttest", "prepare", "preinstall", "install", "postinstall"];
/** Non-code files that can run something or direct what code reads: shell and interpreter scripts,
 * and structured manifests. Only these are followed to their own readers. */
const DIRECTING_EXTENSIONS = /\.(?:sh|bash|zsh|ps1|psm1|bat|cmd|py|rb|pl|json|jsonc|json5|ya?ml|toml|ini|cfg|conf)$/i;

/** Script names reachable from `npm test`, including lifecycle hooks and any script one of those bodies
 * names. Over-inclusive by design: a script name appearing anywhere in a reachable body is followed. */
export function testScriptClosure(scripts: Readonly<Record<string, string>>): Set<string> {
  const closure = new Set<string>();
  const queue = TEST_LIFECYCLE.filter((name) => typeof scripts[name] === "string");
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    for (const hook of [`pre${name}`, `post${name}`]) if (typeof scripts[hook] === "string") queue.push(hook);
    const body = scripts[name] ?? "";
    for (const candidate of Object.keys(scripts)) {
      if (!closure.has(candidate) && new RegExp(`(?:^|[\\s"'=&|;(])${escape(candidate)}(?=$|[\\s"'&|;)])`).test(body)) queue.push(candidate);
    }
  }
  return closure;
}

const GLOB_CHARS = /[*?[\]{}]/;
const PATH_WORD = /^[A-Za-z0-9._\-/@+~*?[\]{}!,]+$/;

/**
 * Whether a script body names `target`, judged word by word (2026-10-28). The reference pattern alone
 * matched a test script that lists `ops/cloudflare/src/a.test.mjs` as naming every file under
 * `ops/cloudflare/`, because the directory is a prefix of the listed file - in one dogfood repository, whose
 * `test` script lists ~60 files, that made every data file under `scripts/` and `ops/` unresolvable.
 * A word that is a different concrete path names that file, not its directories. Anything the check
 * cannot read as a plain path or glob (inline code, variables, quotes inside a word) still counts as
 * naming the target whenever the reference pattern matches it.
 */
export function scriptNamesPath(body: string, target: string, pattern: RegExp, { ancestors = true, cwd = "" }: { ancestors?: boolean; cwd?: string } = {}): boolean {
  if (!pattern.test(body)) return false;
  const targetBase = posix.basename(target);
  const dirs: string[] = [];
  for (let dir = posix.dirname(target); ancestors && dir !== "." && dir !== "/"; dir = posix.dirname(dir)) dirs.push(dir);
  for (const raw of body.split(/\s+/)) {
    const word = raw.replace(/^["']+|["']+$/g, "");
    if (!word) continue;
    for (const candidate of word.includes("=") ? [word, word.slice(word.indexOf("=") + 1)] : [word]) {
      if (!candidate) continue;
      if (!PATH_WORD.test(candidate)) {
        if (pattern.test(candidate) || pattern.test(raw)) return true;
        continue;
      }
      if (candidate.startsWith("../") || candidate.startsWith("/") || candidate.startsWith("~")) {
        if (posix.basename(candidate) === targetBase || pattern.test(` ${candidate} `)) return true;
        continue;
      }
      const resolved = posix.normalize(posix.join(cwd || ".", candidate)).replace(/\/+$/, "");
      if (GLOB_CHARS.test(candidate)) {
        // Character classes are widened to any character, so an unsupported class syntax can only
        // over-match. A glob naming a directory (`ops/*`) reaches the files inside it.
        const widened = resolved.replace(/\[[^\]]*\]/g, "?");
        if ([target, ...dirs].some((path) => matchesGlob(path, widened))) return true;
        continue;
      }
      if (resolved === target || dirs.includes(resolved)) return true;
      if (!candidate.includes("/") && (candidate === targetBase || dirs.some((dir) => posix.basename(dir) === candidate))) return true;
    }
  }
  return false;
}

const CONTENT_PATH_WORD = /[A-Za-z0-9._\-/@+~*?{}[\]!,$]+/g;

/**
 * Whether `content`, read from `readerPath`, names `target` (or, with `ancestors`, one of its
 * directories), once each matching word is read as a whole path (2026-10-28). The reference pattern
 * matches on the basename, so every `wrangler.jsonc` with `"main": "./src/index.js"` named every
 * `src/index.js` in the repository, and `ops/cloudflare/src/a.js` named `ops/cloudflare/src/b.json` by
 * sharing its directory. A word that resolves - from the reader's directory or the repository root - to
 * a different file names that file. Bare names, globs and variables keep the conservative answer.
 */
export function contentNamesPath(content: string, readerPath: string, target: string, pattern: RegExp, ancestors: boolean): boolean {
  if (!pattern.test(content)) return false;
  const dirs: string[] = [];
  for (let dir = posix.dirname(target); ancestors && dir !== "." && dir !== "/"; dir = posix.dirname(dir)) dirs.push(dir);
  const names = [target, ...dirs];
  const readerDir = posix.dirname(readerPath);
  for (const match of content.matchAll(CONTENT_PATH_WORD)) {
    const word = match[0].replace(/[,.]+$/, "");
    if (!pattern.test(`"${word}"`)) continue;
    if (!word.includes("/") || /[*?{}[\]!$]/.test(word)) return true;
    const trimmed = word.replace(/\/+$/, "");
    const resolved = [posix.normalize(posix.join(readerDir, trimmed))];
    if (!trimmed.startsWith("../")) resolved.push(posix.normalize(trimmed.replace(/^\/+/, "")));
    if (resolved.some((path) => names.includes(path))) return true;
    if (trimmed.startsWith(".")) continue;
    // Relative to an unknown working directory, or an absolute path: any suffix relation counts.
    if (names.some((name) => name === trimmed || name.endsWith(`/${trimmed}`) || trimmed.endsWith(`/${name}`))) return true;
  }
  return false;
}

/** Configs that tooling loads by their default name and that can run a repository file - a Worker
 * entry point, a container command, a test setup file, a bundler plugin - without a test naming
 * either. `tsconfig.json`, `.gitignore` and lint or style configs list paths but run nothing; a
 * non-default `wrangler.validation.json` is used only when a command names it. */
const RUNS_FILES_WITHOUT_NAMING = /^(?:wrangler\.(?:toml|json|jsonc)|dockerfile.*|docker-compose.*|compose\.ya?ml|procfile|makefile|justfile|taskfile\.ya?ml|(?:vitest|vite|jest|playwright|cypress|ava|babel|webpack|rollup|esbuild|vue|nuxt|svelte|astro|next)\.config\..+|\.mocharc.*|\.babelrc.*|\.c8rc.*|\.nycrc.*)$/i;

function loadsWithoutNaming(path: string): boolean {
  return RUNS_FILES_WITHOUT_NAMING.test(posix.basename(path));
}

/** A Cloudflare Workers deployment config (`wrangler.toml`, `wrangler.product.jsonc`). */
export function isWorkerConfig(filePath: string): boolean {
  return /^wrangler(?:\.[^./]+)?\.(?:toml|json|jsonc)$/i.test(posix.basename(filePath));
}

const RUNS_WORKER = /unstable_dev|unstable_startWorker|\bminiflare\b|getPlatformProxy|vitest-pool-workers|\b(?:spawn|exec|execFile|execa|fork)(?:Sync)?\([^)]{0,80}["'`](?:npx\s+)?wrangler\b|["'`]wrangler["'`]\s*,\s*\[/i;

/**
 * Whether anything in the repository may run a Worker during tests (2026-10-29). Tooling loads a
 * wrangler config without code naming it, but only when wrangler, Miniflare or the Workers test pool
 * runs. If no code file and no test-closure script does, a test can only observe the config by reading
 * it by name - which the reference resolver handles - so the config need not force full validation.
 * Deliberately repository-wide rather than limited to tests' imports: a test helper may spawn wrangler.
 * Missing contents or an unparseable manifest answer true.
 */
export function suiteMayRunWorkers(files: readonly string[], read: (path: string) => string | undefined, isCodeFile: (path: string) => boolean): boolean {
  const manifest = read("package.json");
  if (manifest === undefined) return true;
  let scripts: Record<string, string>;
  try {
    const parsed = (JSON.parse(manifest) as { scripts?: unknown }).scripts ?? {};
    if (!parsed || typeof parsed !== "object") return true;
    scripts = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return true;
  }
  if ([...testScriptClosure(scripts)].some((name) => /\b(?:wrangler|miniflare)\b/i.test(scripts[name] ?? ""))) return true;
  return files.some((path) => {
    if (!isCodeFile(path) && !/\.config\.[cm]?[jt]s$/.test(path)) return false;
    const content = read(path);
    return content === undefined || RUNS_WORKER.test(content);
  });
}

const ENV_TEMPLATE =/^\.env(?:\.[^.]+)*\.(?:example|sample|template|dist)$|^env\.(?:example|sample|template)$/i;
/** Packages that load `.env.example` without being told its name. */
const IMPLICIT_ENV_TEMPLATE_LOADERS = /["'](?:dotenv-safe|dotenv-extended|dotenv-mono)["']/;

/**
 * Files whose only loader is outside the test process, so with no reader at all the suite cannot
 * observe them (2026-10-28):
 *   - a workflow analyzeGitDelta already showed runs no tests (contentCleared) - GitHub runs it, a test
 *     only sees it by naming it;
 *   - an environment template (`.env.example`) - a person copies it; dotenv loads `.env`, never the
 *     template, unless the repository depends on a loader that reads the template by default.
 * Every other file with no reader stays unknown: absence of a reference is not proof in general.
 */
function loadedOnlyOutsideTests(filePath: string, input: ReferenceResolutionInput, read: (path: string) => string | undefined): boolean {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(filePath)) return input.contentCleared?.has(filePath) === true;
  if (isWorkerConfig(filePath)) return input.workerConfigsOutsideSuite === true;
  if (!ENV_TEMPLATE.test(posix.basename(filePath))) return false;
  const manifest = read("package.json");
  return manifest !== undefined && !IMPLICIT_ENV_TEMPLATE_LOADERS.test(manifest);
}

const PHASE_INTERPRETERS = new Set(["node", "tsx"]);
const PHASE_VALUE_FLAGS = new Set(["--conditions", "-C", "--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--tsconfig"]);

/**
 * The `&&` phases of the root test closure that run `target` directly with an interpreter
 * (`node scripts/test-security.js`, `tsx --import ./setup.mjs scripts/x.ts`), when those phases
 * are the only way the closure names it; undefined otherwise (2026-10-28). Such a phase is a test in
 * all but name: one dogfood repository's `npm test` ends with two, one of which reads every file under `src/`
 * and `scripts/`, and every data file there fell back to the full suite for it. Running the phase
 * itself covers it.
 */
function directTestPhases(content: string, target: string, pattern: RegExp, ancestors: boolean): string[] | undefined {
  let record: Record<string, string>;
  try {
    const scripts = (JSON.parse(content) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object") return undefined;
    record = Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return undefined;
  }
  const found: string[] = [];
  for (const name of testScriptClosure(record)) {
    const rest: string[] = [];
    for (const phase of (record[name] ?? "").split("&&").map((part) => part.trim())) {
      const words = phase.split(/\s+/);
      const runs = words.length >= 2 && PHASE_INTERPRETERS.has(words[0]!)
        && posix.normalize(words[words.length - 1]!) === target
        && words.slice(1, -1).every((word, index, middle) => word.startsWith("-") || PHASE_VALUE_FLAGS.has(middle[index - 1] ?? ""))
        && !/[|;<>`$(]/.test(phase);
      if (runs) found.push(phase); else rest.push(phase);
    }
    if (scriptNamesPath(rest.join(" && "), target, pattern, { ancestors })) return undefined;
  }
  return found.length > 0 ? found : undefined;
}

function packageJsonNames(content: string, pattern: RegExp, target: string, ancestors: boolean, cwd: string): "yes" | "no" | "unparseable" {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return "unparseable"; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unparseable";
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return "no";
  const record = Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  for (const name of testScriptClosure(record)) if (scriptNamesPath(record[name] ?? "", target, pattern, { ancestors, cwd })) return "yes";
  return "no";
}

/** Resolves who reads `filePath`. See the module comment for the rule and its limits. */
export function resolveFileReferences(filePath: string, input: ReferenceResolutionInput): ReferenceResolution {
  const resolution: ReferenceResolution = { tests: [], code: [], unresolvable: [], readers: [], phases: [] };
  const phases = new Set<string>();
  const tests = new Set<string>();
  const code = new Set<string>();
  const visited = new Set<string>([filePath]);
  let frontier: Array<{ path: string; via: string }> = [{ path: filePath, via: filePath }];
  let transitiveCount = 0;
  const contents = new Map<string, string | undefined>();
  const read = (path: string) => { if (!contents.has(path)) contents.set(path, input.read(path)); return contents.get(path); };

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: Array<{ path: string; via: string }> = [];
    for (const target of frontier) {
      // Directories are matched only for the changed file itself, which a test may find by listing its
      // directory. A reader reached through the changed file (a script, a manifest) matters only if
      // something runs or reads it by name; matching its directories as well made `"tests"` and
      // `"fixtures"` match nearly every file and no generic name (package.json) could resolve.
      const ancestors = target.path === filePath;
      const pattern = referencePattern(referenceTokens(target.path, { ancestors }));
      for (const candidate of input.files) {
        if (visited.has(candidate) || candidate === target.path || LOCKFILES.has(posix.basename(candidate))) continue;
        const base = posix.basename(candidate);
        if (base === "package.json") {
          const content = read(candidate);
          if (content === undefined) {
            if (input.allowNoReaders) resolution.unresolvable.push(`${candidate} could not be read`);
            continue;
          }
          const named = packageJsonNames(content, pattern, target.path, ancestors, posix.dirname(candidate));
          if (named === "no") continue;
          visited.add(candidate);
          if (named === "unparseable") { resolution.unresolvable.push(`${candidate} could not be parsed`); continue; }
          resolution.readers.push({ path: candidate, kind: "package-script", via: target.path });
          const direct = input.testPhases && candidate === "package.json" ? directTestPhases(content, target.path, pattern, ancestors) : undefined;
          if (direct) { for (const phase of direct) phases.add(phase); continue; }
          resolution.unresolvable.push(`${candidate} runs ${target.path} as part of its test script`);
          continue;
        }
        if (input.isDocumentation(candidate)) continue;
        const content = read(candidate);
        if (content === undefined && input.allowNoReaders && (input.isCodeFile(candidate) || DIRECTING_EXTENSIONS.test(candidate) || isImplicitlyLoadedFile(candidate))) {
          resolution.unresolvable.push(`${candidate} could not be read`);
          continue;
        }
        if (content === undefined || !contentNamesPath(content, candidate, target.path, pattern, ancestors)) continue;
        visited.add(candidate);
        if (input.implicitReadersUnresolvable && loadsWithoutNaming(candidate)) {
          resolution.readers.push({ path: candidate, kind: "unresolvable", via: target.path });
          resolution.unresolvable.push(`${candidate} is loaded by tooling and names ${target.path}`);
        } else if (candidate.startsWith(".github/")) {
          // A workflow step that comes before a test step in its job, or a composite action, may feed
          // the file to the suite's environment; issue templates and standalone CI checks do not.
          // A change content inspection already showed cannot alter how tests run (a version bump)
          // stays that way when a workflow reads the file.
          const executes = candidate.startsWith(".github/actions/")
            || (/^\.github\/workflows\//.test(candidate) && !input.contentCleared?.has(target.path) && input.workflowFeedsTests(content, pattern));
          if (!executes) continue;
          resolution.readers.push({ path: candidate, kind: "unresolvable", via: target.path });
          resolution.unresolvable.push(`${candidate} names ${target.path}`);
        } else if (input.isCodeFile(candidate) && input.isTestFile(candidate)) {
          resolution.readers.push({ path: candidate, kind: "test", via: target.path });
          tests.add(candidate);
        } else if (input.isCodeFile(candidate) && input.inGraph(candidate)) {
          resolution.readers.push({ path: candidate, kind: "graph-code", via: target.path });
          code.add(candidate);
        } else if (input.isCodeFile(candidate) || DIRECTING_EXTENSIONS.test(candidate)) {
          resolution.readers.push({ path: candidate, kind: "transitive", via: target.path });
          if (++transitiveCount > MAX_TRANSITIVE_READERS) { resolution.unresolvable.push(`more than ${MAX_TRANSITIVE_READERS} non-code files name ${filePath}`); break; }
          next.push({ path: candidate, via: target.path });
        } else {
          // Markup, prose, images and licences name paths in links and URLs but execute nothing and
          // direct no reads, so nothing reaches the suite through them.
          resolution.readers.push({ path: candidate, kind: "documentation", via: target.path });
        }
      }
      if (resolution.unresolvable.length > 0) break;
    }
    if (resolution.unresolvable.length > 0) break;
    frontier = next;
  }
  if (resolution.unresolvable.length === 0 && frontier.length > 0) {
    resolution.unresolvable.push(`reference chain from ${filePath} is deeper than ${MAX_DEPTH} files`);
  }
  // Found readers that something could run (check scripts, manifests), none of which any test, test
  // script or test-feeding workflow step reaches: the suite cannot observe the file. Finding no such
  // reader at all is different - the file's reader is unknown, so it stays unknown.
  const executableReaders = resolution.readers.some((reader) => reader.kind === "transitive");
  if (resolution.unresolvable.length === 0 && tests.size === 0 && code.size === 0 && !executableReaders && !input.allowNoReaders && !loadedOnlyOutsideTests(filePath, input, read)) {
    resolution.unresolvable.push(`no test or source file names ${filePath}`);
  }
  resolution.phases = resolution.unresolvable.length === 0 ? [...phases].sort() : [];
  resolution.tests = [...tests].sort();
  resolution.code = [...code].sort();
  return resolution;
}
