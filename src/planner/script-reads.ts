// SPDX-License-Identifier: MIT
/**
 * Which paths does a repository check script read? (2026-10-29, docs/design/pipeline-impact.md, phase 1
 * slice 3.)
 *
 * This is the inverse of the reference resolver (`src/repo/file-references.ts`): there the question is
 * "which files name the changed path", here it is "which paths does this check name". Dogfood check
 * scripts name what they walk: `sourceFiles(path.join(root, "src"))`, `join(root,
 * "ops/cloudflare/d1-migrations")`, `readFileSync(join(root, "package.json"))`. A script that names `src`
 * reads everything under `src/`; a change elsewhere cannot change its result.
 *
 * THE RULE. The script's closure is the script file plus every relative module it imports, transitively.
 * Its reads are every string literal in the closure, and every argument on its command line, that is a
 * tracked file or directory (relative to the repository root or to the module's directory), plus the
 * static prefix of each template literal. The check runs when a changed path:
 *
 *   - is in the closure (the check's own code changed);
 *   - is, or is under, a path the closure names; or has a basename the closure names (`"index.ts"`);
 *   - is package.json or a lockfile and the closure imports a package or names package.json.
 *
 * FAILING CLOSED. The check runs as written, for any change, when its reads cannot be bounded: it runs
 * another program (child_process), walks the repository root or the working directory, uses a glob that
 * starts at the root, reads a path from the environment, its closure cannot be read or is too large, or the
 * command is not `node`/`tsx`/`bun` running one JavaScript or TypeScript file.
 *
 * RESIDUAL RISK. A path assembled from parts that never appear as literals (`["s", "rc"].join("")`) is not
 * seen, as in the reference resolver. Required CI stays authoritative.
 */

import { posix } from "node:path";
import ts from "typescript";
import type { NarrowingInput } from "./check-narrowing.js";
import type { GateCheck } from "./pipeline-steps.js";

const MAX_CLOSURE = 400;
const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
const SCRIPT_FILE = /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/;
const RESOLVE_EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", "/index.js", "/index.mjs", "/index.ts", "/index.tsx"];
const VALUE_FLAGS = new Set(["--import", "-r", "--require", "--loader", "--experimental-loader", "--conditions", "-C", "--env-file", "--tsconfig"]);

const SPAWNS = /\bchild_process\b|\bexeca\b|\bzx\b|\bBun\.spawn|\bDeno\.Command/;
const ROOT_NAME = String.raw`(?:root|ROOT|repoRoot|REPO_ROOT|rootDir|ROOT_DIR|projectRoot|PROJECT_ROOT|repositoryRoot|REPOSITORY_ROOT|cwd|process\.cwd\(\)|["'\`]\.{0,2}\/?["'\`])`;
/** A directory walk, glob or listing that starts at the repository root or the working directory. */
const WALKS_ROOT = new RegExp(String.raw`\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|globby|fg|fastGlob|walk\w*|list\w*|\w*[Ff]iles|scan\w*|collect\w*)\s*\(\s*${ROOT_NAME}\s*[,)]|\bcwd\s*:\s*${ROOT_NAME}|["'\`](?:\.\/)?\*\*`);
const ENV_PATH = /process\.env\.\w*(?:PATH|DIR|ROOT|FILE)\b|process\.env\[/;

/**
 * String literals (and each template's static head) and module specifiers, read with the TypeScript
 * parser: regular expressions, comments and templates with substitutions defeat a regex scan (one
 * swallowed `path.join(root, "src")` across lines). Undefined when a `require` or `import()` takes a
 * computed specifier.
 */
function scanModule(path: string, text: string): { literals: string[]; imports: string[] } | undefined {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const literals: string[] = [];
  const imports: string[] = [];
  let computed = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) imports.push(argument.text);
      else computed = true;
    }
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    else if (ts.isTemplateExpression(node)) literals.push(node.head.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return computed ? undefined : { literals, imports };
}

interface Reads {
  closure: Set<string>;
  paths: Set<string>;
  basenames: Set<string>;
  importsPackages: boolean;
}

/** The file a `node`/`tsx`/`bun` leaf runs, and its remaining arguments. */
function scriptOf(command: string): { file: string; args: string[] } | undefined {
  const words = command.trim().split(/\s+/);
  let index = 0;
  if (words[index] === "npx") { index++; if (words[index] === "--no-install") index++; }
  if (!["node", "tsx", "bun", "ts-node"].includes(words[index] ?? "")) return undefined;
  if (words[index] === "bun" && words[index + 1] === "run") index++;
  for (index++; index < words.length && words[index]!.startsWith("-"); index++) {
    if (VALUE_FLAGS.has(words[index]!) ) index++;
  }
  const file = words[index];
  if (!file || !SCRIPT_FILE.test(file) || /["'$`]/.test(command)) return undefined;
  return { file: posix.normalize(file), args: words.slice(index + 1) };
}

function directories(files: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) for (let dir = posix.dirname(file); dir !== "." && !dirs.has(dir); dir = posix.dirname(dir)) dirs.add(dir);
  return dirs;
}

/** Reads of the script's closure, or a reason they cannot be bounded. */
function collectReads(entry: string, args: readonly string[], input: NarrowingInput, files: readonly string[]): Reads | string {
  const tracked = new Set(files);
  const dirs = directories(files);
  const reads: Reads = { closure: new Set(), paths: new Set(), basenames: new Set(), importsPackages: false };
  const addLiteral = (literal: string, from: string): void => {
    const value = literal.replace(/\\\\/g, "/").trim();
    if (!value || value.length > 300 || /[\s*?{}<>|]/.test(value.replace(/\/$/, ""))) return;
    for (const base of [".", posix.dirname(from)]) {
      const path = posix.normalize(posix.join(base, value)).replace(/\/$/, "");
      if (path.startsWith("..") || path === ".") continue;
      if (tracked.has(path) || dirs.has(path)) reads.paths.add(path);
    }
    if (/^[\w@+-][\w.@+-]*\.\w+$/.test(value)) reads.basenames.add(value);
  };
  for (const arg of args) addLiteral(arg, ".");

  const queue = [entry];
  while (queue.length) {
    const module = queue.shift()!;
    if (reads.closure.has(module)) continue;
    if (reads.closure.size >= MAX_CLOSURE) return `its import closure exceeds ${MAX_CLOSURE} files`;
    const text = input.read(module);
    if (text === undefined) return `${module} could not be read`;
    reads.closure.add(module);
    if (SPAWNS.test(text)) return `${module} runs another program`;
    if (WALKS_ROOT.test(text)) return `${module} walks the repository root`;
    if (ENV_PATH.test(text)) return `${module} reads a path from the environment`;
    const scanned = scanModule(module, text);
    if (!scanned) return `${module} loads a module by a computed name`;
    for (const specifier of scanned.imports) {
      // Path aliases (`@/lib/x`, `~/x`, `#x`) reach repository code this module cannot follow.
      if (/^(?:@\/|~\/|#)/.test(specifier)) return `${module} imports ${specifier} through a path alias`;
      if (specifier.startsWith(".")) {
        const base = posix.normalize(posix.join(posix.dirname(module), specifier));
        const resolved = RESOLVE_EXTENSIONS.map((ext) => base + ext).find((candidate) => tracked.has(candidate))
          ?? (tracked.has(base.replace(/\.js$/, ".ts")) ? base.replace(/\.js$/, ".ts") : undefined);
        if (resolved) queue.push(resolved);
        else return `${module} imports ${specifier}, which is not a tracked file`;
      } else if (!specifier.startsWith("node:") && !/^(?:fs|path|os|url|util|assert|crypto|child_process|stream|events|zlib|readline|process|module|worker_threads|http|https|net|buffer|timers)(?:\/|$)/.test(specifier)) {
        reads.importsPackages = true;
      }
    }
    for (const literal of scanned.literals) addLiteral(literal, module);
    if (/__dirname|import\.meta\.(?:dirname|url)/.test(text) && posix.dirname(module) !== ".") reads.paths.add(posix.dirname(module));
  }
  return reads;
}

/** RUN or SKIP for a check that runs one repository script; other checks are returned unchanged. */
export function decideScriptCheck(check: GateCheck, input: NarrowingInput): GateCheck {
  if (check.kind !== "script" || !input.files) return check;
  if (check.runsScript && input.lifecycleHooks !== false
    && (input.scripts[`pre${check.script}`] !== undefined || input.scripts[`post${check.script}`] !== undefined)) return check;
  const script = scriptOf(check.command);
  if (!script) return check;
  const run = (reason: string): GateCheck => ({ ...check, decision: "RUN", reason });
  const reads = collectReads(script.file, script.args, input, input.files);
  if (typeof reads === "string") return run(`${reads}: runs for any change`);

  for (const { path } of input.changes) {
    if (reads.closure.has(path)) return run(`${path} changed, and the check runs it`);
    const named = [...reads.paths].find((read) => path === read || path.startsWith(`${read}/`));
    if (named) return run(`reads ${named}, which contains ${path}`);
    if (reads.basenames.has(posix.basename(path))) return run(`names ${posix.basename(path)}`);
    const base = posix.basename(path);
    if ((path === "package.json" || LOCKFILE.test(base)) && (reads.importsPackages || reads.paths.has("package.json"))) return run(`${path} changed and the check imports packages`);
  }
  const shown = [...reads.paths].sort().slice(0, 4);
  const more = reads.paths.size > shown.length ? ` and ${reads.paths.size - shown.length} more` : "";
  return { ...check, decision: "SKIP", reason: `reads ${shown.length ? shown.join(", ") + more : "only its own code"}; no changed file there` };
}
