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
import { LOCKFILE_NAMES } from "./lockfiles.js";

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

/**
 * Coding-agent configuration (2026-11-07): MCP server lists, agent hooks, rules and skills. Only coding
 * agents read these; no build, test runner or CI job does, so a change to one, or a package it names,
 * cannot change a test result. `diffci init` writes several of them, and on DentalPresence the first
 * commit carrying them ran all 624 tests ("Unknown changed file: .mcp.json") and kept a DiffCI bump
 * from narrowing.
 */
export function isAgentConfigurationPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === ".mcp.json") return true;
  return /^\.(?:claude|codex)\//.test(normalized) || /^\.cursor\/(?:mcp\.json$|hooks\.json$|rules\/)/.test(normalized);
}

/**
 * Whether `content` of a tsconfig/jsconfig names something outside `include`, `exclude` and `files`
 * (2026-11-07). Those list paths, not packages: DentalPresence's `"exclude": ["diffci"]`, a directory,
 * read as tsconfig loading the `diffci` CLI and blocked every bump of it. `extends`, `types`, `plugins`
 * and `paths` still count.
 */
export function compilerConfigNames(filePath: string, content: string, named: RegExp): boolean {
  if (!/^[jt]sconfig[^/]*\.json$/i.test(posix.basename(filePath))) return named.test(content);
  return named.test(content.replace(/"(?:include|exclude|files)"\s*:\s*\[[^\]]*\]/g, ""));
}

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
  workflowFeedsTests: (content: string, names: (text: string) => boolean) => boolean;
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
  /** The file is gone at HEAD and the graph has shown nothing can still import it (ImpactAnalyzer's
   * resolveRemovedFile). Only a reader naming the file itself, not its directories, can observe its
   * absence, and finding none is not a gap; an unreadable file is skipped as in any other resolution. */
  removed?: boolean;
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
  /** Each unresolvable reason with the readers leading to it, from the changed file to the file it was
   * found through. Every blocker of the level where the first one appeared is reported, not only the first,
   * so one run explains a fallback that used to take one fix per blocker to uncover (2026-11-05). */
  blockers: Array<{ reason: string; chain: string[] }>;
  /** Every reader found, for evidence. */
  readers: Array<{ path: string; kind: ReaderKind; via: string }>;
  /** Phases of the root test script, verbatim, that run a reader directly; the caller must run them.
   * Only produced with `testPhases`. */
  phases: string[];
}

const MAX_DEPTH = 5;
const MAX_TRANSITIVE_READERS = 50;
const LOCKFILES: ReadonlySet<string> = new Set(LOCKFILE_NAMES);
const TEST_LIFECYCLE = ["pretest", "test", "posttest", "prepare", "preinstall", "install", "postinstall"];
/** Non-code files that can run something or direct what code reads: shell and interpreter scripts,
 * and structured manifests. Only these are followed to their own readers. */
export const DIRECTING_EXTENSIONS = /\.(?:sh|bash|zsh|ps1|psm1|bat|cmd|py|rb|pl|json|jsonc|json5|ya?ml|toml|ini|cfg|conf)$/i;

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
  // A file name with an extension is the script's own directory's file (`vitest -c vitest.config.mts` in
  // apps/cli/package.json is apps/cli's config, not packages/alint's; 2026-11-05) unless the script runs
  // somewhere else: a `cd`, a workspace-wide run or a directory flag keeps any same-named file.
  const elsewhere = /(?:^|[\s;&|(])(?:cd|pushd)\s|--(?:dir|cwd|prefix|filter|recursive|workspaces?)\b|(?:^|\s)-[rC]\s|\b(?:turbo|nx|lerna)\b/.test(body);
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
      if (!candidate.includes("/") && ((candidate === targetBase && (elsewhere || !/\.[A-Za-z0-9]+$/.test(candidate))) || dirs.some((dir) => posix.basename(dir) === candidate))) return true;
    }
  }
  return false;
}

const CONTENT_PATH_WORD = /[A-Za-z0-9._\-/@+~*?{}[\]!,$]+/g;

/** Keys whose list names files a tool skips: tsconfig and Vitest `exclude`, knip `ignore`, ESLint-style
 * `ignores` and `ignorePatterns`, Jest `testPathIgnorePatterns` and its siblings. */
const EXCLUSION_KEY = /^(?:ignored?|ignores|excluded?|excludes|ignorePatterns|\w*PathIgnorePatterns)$/;

/**
 * Whether the word at `index` is an element of a bracketed list assigned to an exclusion key
 * (`exclude: [...]`, `"exclude": [...]`, `ignores = [...]`) (2026-11-05). A tool never reads what its
 * own ignore list excludes, yet each such glob counted as a reader: on LobeHub, knip's
 * `ignore: ['scripts/**']`, alint's `ignores = ["**\/fixtures/**"]` and a Vitest `exclude` named every
 * data file of a migration under scripts/, and each change to one ran the full suite. YAML block lists
 * and anything not directly inside such a list keep the conservative answer.
 */
function inExclusionList(content: string, index: number): boolean {
  // Closers seen so far, so a balanced `{x,}` or `[!d]` in an earlier glob of the same list is skipped.
  const open: Record<string, number> = { "[": 0, "{": 0, "(": 0 };
  const opener: Record<string, string> = { "]": "[", "}": "{", ")": "(" };
  for (let i = index - 1; i >= 0; i--) {
    const char = content[i]!;
    if (char in opener) { open[opener[char]!]!++; continue; }
    if (!(char in open)) continue;
    if (open[char]! > 0) { open[char]!--; continue; }
    // The innermost unclosed bracket: a list, or an object or call the word sits directly inside.
    if (char !== "[") return false;
    const key = /["']?([A-Za-z_$][\w$]*)["']?\s*[:=]\s*$/.exec(content.slice(Math.max(0, i - 80), i));
    return key !== null && EXCLUSION_KEY.test(key[1]!);
  }
  return false;
}

/**
 * Whether code in `readerPath` could be naming `target` by its bare file name: it sits in the target's
 * directory, or its text names one of the target's directories as a word (`"hotfixWorkflow"`,
 * `scripts/`), which is how code elsewhere would reach that directory to run or read a file there. Only
 * applied to a reader of a reader (`ancestors` false): 2026-11-06, a LobeHub root package.json edit
 * reached scripts/hotfixWorkflow/index.ts, and every code file in the repository containing the word
 * `index.ts` became a further reader until the 50-reader limit forced the full suite. Non-code readers
 * (shell scripts, workflow and tool configuration) set their working directory in ways not modelled
 * here, so they still count on the bare name.
 */
function namesDirectoryOf(content: string, readerPath: string, target: string): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(readerPath)) return true;
  const dir = posix.dirname(target);
  if (dir === "." || posix.dirname(readerPath) === dir) return true;
  const names = dir.split("/").filter(Boolean);
  return names.some((name) => new RegExp(`(?:^|["'\`/\s(])${escape(name)}(?=$|["'\`/\s),])`, "m").test(content));
}

/**
 * Whether `content`, read from `readerPath`, names `target` (or, with `ancestors`, one of its
 * directories), once each matching word is read as a whole path (2026-10-28). The reference pattern
 * matches on the basename, so every `wrangler.jsonc` with `"main": "./src/index.js"` named every
 * `src/index.js` in the repository, and `ops/cloudflare/src/a.js` named `ops/cloudflare/src/b.json` by
 * sharing its directory. A word that resolves - from the reader's directory or the repository root - to
 * a different file names that file, and a glob names only what it matches (2026-11-04). Bare names and
 * variables inside a path keep the conservative answer.
 */
export function contentNamesPath(content: string, readerPath: string, target: string, pattern: RegExp, ancestors: boolean, readGlobs = true): boolean {
  if (!pattern.test(content)) return false;
  const dirs: string[] = [];
  for (let dir = posix.dirname(target); ancestors && dir !== "." && dir !== "/"; dir = posix.dirname(dir)) dirs.push(dir);
  const names = [target, ...dirs];
  const readerDir = posix.dirname(readerPath);
  for (const match of content.matchAll(CONTENT_PATH_WORD)) {
    let word = match[0].replace(/[,.]+$/, "");
    // Judged with the characters around it, so a bare directory name in prose (`the overlay packages,`
    // in a workflow comment) does not count, as the reference pattern intends (2026-11-04).
    if (!pattern.test(content.slice(Math.max(0, match.index - 1), match.index + word.length + 1))) continue;
    if (inExclusionList(content, match.index)) continue;
    // A leading variable is a directory the content does not name (`$GITHUB_ACTION_PATH/../../scripts/x.sh`
    // names `scripts/x.sh` somewhere, not the repository's `scripts/`), so the rest is a path relative to
    // an unknown directory (2026-11-04: a LobeHub composite action blocked every changed file under scripts/).
    const variable = /^\$(?:\{[\w.]+\}|\w+)\/(.+)$/.exec(word);
    if (variable && !/[*?{}[\]!$]/.test(variable[1]!)) {
      const rest = variable[1]!.replace(/^(?:\.\.?\/)+/, "").replace(/\/+$/, "");
      if (names.some((name) => name === rest || name.endsWith(`/${rest}`) || rest.endsWith(`/${name}`))) return true;
      continue;
    }
    if (!word.includes("/") && !/[!$]/.test(word) && !ancestors && !namesDirectoryOf(content, readerPath, target)) continue;
    if (!word.includes("/") || /[!$]/.test(word)) return true;
    if (/[*?{}[\]]/.test(word)) {
      if (!readGlobs) continue;
      if (word.startsWith("../")) return true;
      // A glob names what it matches, from the reader's directory, the root, or any directory below the
      // root; `packages/sdk/**` in a workflow's `paths` filter does not name `packages/database/`.
      word = word.replace(/\[[^\]]*\]/g, "?").replace(/^\/+/, "");
      const globs = word.startsWith("./") ? [posix.join(readerDir, word), word.slice(2)] : [word, posix.join(readerDir, word), `**/${word}`];
      if (names.some((name) => globs.some((glob) => matchesGlob(name, glob)))) return true;
      continue;
    }
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

/** Calls that list a directory's contents, in the languages Core analyses and the scripts tests run. */
const DIRECTORY_WALK = /\b(?:readdir(?:Sync)?|opendir(?:Sync)?|globSync|glob|fastGlob|fg|globby|walk(?:Sync)?|scandir|listdir|iterdir|rglob|WalkDir|Walk|ReadDir|Files\.(?:walk|list|find)|listFiles)\s*\(/;

/** Whether `content` calls a directory-listing API; callers pre-filter tests with it once per analysis. */
export function listsDirectories(content: string | undefined): boolean {
  return content !== undefined && DIRECTORY_WALK.test(content);
}

/**
 * Tests that list a directory containing `filePath` (2026-11-04). The CI replay's one miss: a commit
 * added `scripts/ci-reproduction.ts`, and a test that reads every file under `scripts/` failed. Nothing
 * imports a new script, so the graph selected nothing for it, and no fallback said so. A test that calls a
 * directory-listing API and names one of the file's ancestor directories now counts as reading it.
 * Additive only: it never narrows a selection. A walk that starts at the repository root without naming
 * a directory is still invisible, as in resolveFileReferences.
 */
export function directoryWalkers(filePath: string, tests: readonly string[], read: (path: string) => string | undefined): string[] {
  const pattern = referencePattern(referenceTokens(filePath));
  return tests.filter((test) => {
    const content = read(test);
    return listsDirectories(content) && contentNamesPath(content!, test, filePath, pattern, true);
  });
}

/** Configs that tooling loads by their default name and that can run a repository file - a Worker
 * entry point, a container command, a test setup file, a bundler plugin - without a test naming
 * either. `tsconfig.json`, `.gitignore` and lint or style configs list paths but run nothing; a
 * non-default `wrangler.validation.json` is used only when a command names it. */
const RUNS_FILES_WITHOUT_NAMING = /^(?:wrangler\.(?:toml|json|jsonc)|dockerfile.*|docker-compose.*|compose\.ya?ml|procfile|makefile|justfile|taskfile\.ya?ml|(?:vitest|vite|jest|playwright|cypress|ava|babel|webpack|rollup|esbuild|vue|nuxt|svelte|astro|next)\.config\..+|\.mocharc.*|\.babelrc.*|\.c8rc.*|\.nycrc.*)$/i;

/** TypeScript project files: they list what to compile, and a non-code file they name is read only
 * through an import, which the dependency graph already has. */
const PATH_LIST_CONFIG = /^[jt]sconfig(?:\.[^/]+)?\.json$/i;
const LINTERS = new Set(["eslint", "oxlint", "stylelint", "prettier", "alint", "cspell", "markdownlint", "commitlint", "lintstaged", "lint-staged", "biome", "knip", "dprint"]);

/** A linter's or formatter's configuration (`alint.config.toml`, `.eslintrc.json`, `biome.json`). */
export function isLintConfig(filePath: string): boolean {
  const base = posix.basename(filePath).toLowerCase();
  const stem = base.replace(/^\./, "").split(".")[0]!;
  const tool = stem.replace(/rc$/, "");
  if (!LINTERS.has(tool)) return false;
  return stem !== tool || base.includes(".config.") || /^(?:biome|knip|dprint|cspell)\.(?:json|jsonc|ts|js|mjs|cjs|ya?ml)$/.test(base);
}

export function loadsWithoutNaming(path: string): boolean {
  return RUNS_FILES_WITHOUT_NAMING.test(posix.basename(path));
}

/** A root dependency manifest that a Dockerfile names only in `COPY`/`ADD` instructions, which put it
 * into the image for a package manager to install from. Any other instruction naming it (a `RUN` that
 * reads it) does not qualify. Comment lines execute nothing and are ignored, so a Dockerfile that names
 * the file only in comments qualifies too (2026-11-05: two dogfood-repository Dockerfiles' `# ... pinned in
 * package.json` comments blocked every dependency bump). */
function copiesOnly(content: string, target: string): boolean {
  if (target.includes("/") || !["package.json", ...LOCKFILES].includes(target)) return false;
  // Any mention at all, so an unusual boundary (`RUN jq .version<package.json`) still counts as a read.
  const lines = content.split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && line.includes(target));
  return lines.every((line) => /^\s*(?:COPY|ADD)\s/i.test(line));
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
  const resolution: ReferenceResolution = { tests: [], code: [], unresolvable: [], blockers: [], readers: [], phases: [] };
  const parent = new Map<string, string>();
  const chainOf = (path: string) => { const chain = [path]; while (parent.has(chain[0]!)) chain.unshift(parent.get(chain[0]!)!); return chain; };
  const block = (reason: string, through: string) => { resolution.unresolvable.push(reason); resolution.blockers.push({ reason, chain: chainOf(through) }); };
  const phases = new Set<string>();
  const tests = new Set<string>();
  const code = new Set<string>();
  const visited = new Set<string>([filePath]);
  // `lint`: the file configures a linter, so only a test or graph code naming it is followed; anything else
  // that reads it is lint tooling and runs no test (isLintConfig; 2026-11-05: LobeHub's oxlint.config.mts
  // chain under scripts/stylexMigration/legacyFiles.json went past the depth limit).
  let frontier: Array<{ path: string; via: string; lint?: boolean }> = [{ path: filePath, via: filePath }];
  let transitiveCount = 0;
  const contents = new Map<string, string | undefined>();
  const read = (path: string) => { if (!contents.has(path)) contents.set(path, input.read(path)); return contents.get(path); };

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: Array<{ path: string; via: string; lint?: boolean }> = [];
    for (const target of frontier) {
      // Directories are matched only for the changed file itself, which a test may find by listing its
      // directory. A reader reached through the changed file (a script, a manifest) matters only if
      // something runs or reads it by name; matching its directories as well made `"tests"` and
      // `"fixtures"` match nearly every file and no generic name (package.json) could resolve.
      const ancestors = target.path === filePath && !input.removed;
      const pattern = referencePattern(referenceTokens(target.path, { ancestors }));
      for (const candidate of input.files) {
        if (visited.has(candidate) || candidate === target.path || LOCKFILES.has(posix.basename(candidate))) continue;
        const base = posix.basename(candidate);
        // A lint step in a workflow or a package's lint script reads a linter's configuration to lint,
        // which no test observes; a test or graph code naming it is still followed (2026-11-05: LobeHub's
        // alint.config.toml names fixture directories and its test workflow runs alint before the tests).
        if (target.lint && (base === "package.json" || candidate.startsWith(".github/"))) continue;
        if (base === "package.json") {
          const content = read(candidate);
          if (content === undefined) {
            if (input.allowNoReaders) block(`${candidate} could not be read`, target.path);
            continue;
          }
          const named = packageJsonNames(content, pattern, target.path, ancestors, posix.dirname(candidate));
          if (named === "no") continue;
          visited.add(candidate);
          if (named === "unparseable") { block(`${candidate} could not be parsed`, target.path); continue; }
          resolution.readers.push({ path: candidate, kind: "package-script", via: target.path });
          const direct = input.testPhases && candidate === "package.json" ? directTestPhases(content, target.path, pattern, ancestors) : undefined;
          if (direct) { for (const phase of direct) phases.add(phase); continue; }
          block(`${candidate} runs ${target.path} as part of its test script`, target.path);
          continue;
        }
        if (input.isDocumentation(candidate)) continue;
        // 2026-11-05: LobeHub's root tsconfig `include` names scripts/, and with every tsconfig extending it
        // the readers of scripts/stylexMigration/legacyFiles.json passed the transitive limit. tsc compiles
        // what a tsconfig lists and runs none of it, and changed code it compiles is a compiled project's.
        if (PATH_LIST_CONFIG.test(base)) continue;
        const content = read(candidate);
        if (content === undefined && input.allowNoReaders && (input.isCodeFile(candidate) || DIRECTING_EXTENSIONS.test(candidate) || isImplicitlyLoadedFile(candidate))) {
          block(`${candidate} could not be read`, target.path);
          continue;
        }
        // A test runner's include and exclude globs select test files, so one matching a data file does not
        // make the runner read it; an exact path in the config still counts (2026-11-05: LobeHub's
        // packages/alint/vitest.config.mts excludes fixture directories under scripts/).
        const globsSelectTests = loadsWithoutNaming(candidate) && !input.isCodeFile(target.path);
        if (content === undefined || !contentNamesPath(content, candidate, target.path, pattern, ancestors, !globsSelectTests)) continue;
        visited.add(candidate);
        if (input.allowNoReaders && /^dockerfile/i.test(base) && copiesOnly(content, target.path)) {
          // The caller modelled what the file does when installed (dependency selection); a Dockerfile
          // that only copies it into the image to install from it adds nothing (2026-11-04: a dogfood repository's
          // `COPY package.json package-lock.json ./` made every dependency bump a full run).
          resolution.readers.push({ path: candidate, kind: "documentation", via: target.path });
        } else if (input.implicitReadersUnresolvable && loadsWithoutNaming(candidate)) {
          resolution.readers.push({ path: candidate, kind: "unresolvable", via: target.path });
          block(`${candidate} is loaded by tooling and names ${target.path}`, target.path);
        } else if (candidate.startsWith(".github/")) {
          // A workflow step that comes before a test step in its job, or a composite action, may feed
          // the file to the suite's environment; issue templates and standalone CI checks do not.
          // A change content inspection already showed cannot alter how tests run (a version bump)
          // stays that way when a workflow reads the file.
          const executes = candidate.startsWith(".github/actions/")
            || (/^\.github\/workflows\//.test(candidate) && !input.contentCleared?.has(target.path) && input.workflowFeedsTests(content, (text) => contentNamesPath(text, candidate, target.path, pattern, ancestors)));
          if (!executes) continue;
          resolution.readers.push({ path: candidate, kind: "unresolvable", via: target.path });
          block(`${candidate} names ${target.path}`, target.path);
        } else if (input.isCodeFile(candidate) && input.isTestFile(candidate)) {
          resolution.readers.push({ path: candidate, kind: "test", via: target.path });
          tests.add(candidate);
        } else if (input.isCodeFile(candidate) && input.inGraph(candidate)) {
          resolution.readers.push({ path: candidate, kind: "graph-code", via: target.path });
          code.add(candidate);
        } else if (!target.lint && (input.isCodeFile(candidate) || DIRECTING_EXTENSIONS.test(candidate))) {
          resolution.readers.push({ path: candidate, kind: "transitive", via: target.path });
          if (++transitiveCount > MAX_TRANSITIVE_READERS) { block(`more than ${MAX_TRANSITIVE_READERS} non-code files name ${filePath}`, target.path); break; }
          parent.set(candidate, target.path);
          next.push({ path: candidate, via: target.path, lint: isLintConfig(candidate) });
        } else {
          // Markup, prose, images and licences name paths in links and URLs but execute nothing and
          // direct no reads, so nothing reaches the suite through them.
          resolution.readers.push({ path: candidate, kind: "documentation", via: target.path });
        }
      }
      if (transitiveCount > MAX_TRANSITIVE_READERS) break;
    }
    if (resolution.unresolvable.length > 0) break;
    frontier = next;
  }
  if (resolution.unresolvable.length === 0 && frontier.length > 0) {
    block(`reference chain from ${filePath} is deeper than ${MAX_DEPTH} files`, filePath);
  }
  // Found readers that something could run (check scripts, manifests), none of which any test, test
  // script or test-feeding workflow step reaches: the suite cannot observe the file. Finding no such
  // reader at all is different - the file's reader is unknown, so it stays unknown.
  const executableReaders = resolution.readers.some((reader) => reader.kind === "transitive");
  if (resolution.unresolvable.length === 0 && tests.size === 0 && code.size === 0 && !executableReaders && !input.allowNoReaders && !input.removed && !loadedOnlyOutsideTests(filePath, input, read)) {
    block(`no test or source file names ${filePath}`, filePath);
  }
  resolution.phases = resolution.unresolvable.length === 0 ? [...phases].sort() : [];
  resolution.tests = [...tests].sort();
  resolution.code = [...code].sort();
  return resolution;
}
