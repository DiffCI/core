// SPDX-License-Identifier: MIT
/**
 * Narrowing gate checks to a change (2026-10-29, docs/design/pipeline-impact.md, phase 1 slice 2).
 *
 * A per-file linter or formatter (`eslint "src/**\/*.ts"`, `prettier --check .`) judges each file on its
 * own, so after a change it only needs the changed files it would have covered. When none of them is
 * covered, it can be skipped.
 *
 * THE RULES, each failing toward running more:
 *
 *   - Only `eslint` and `prettier --check` leaves whose every flag is known are touched. Anything else
 *     keeps its decision.
 *   - A change to the tool's configuration, an ignore file, a file the configuration names by a relative
 *     path, `package.json` or a lockfile runs the whole check.
 *   - ESLint rules that read other files make lint whole-program: type-aware parsing (`project`,
 *     `projectService`, `*TypeChecked` configs), import-plugin rules, boundary plugins, and any nested
 *     ESLint configuration (only the root one is read). Whole-program lint runs as written whenever a code
 *     file changed and is skipped only when none did.
 *   - A deleted code file can break an import in a file that remains: ESLint then runs as written.
 *   - `--max-warnings` with a narrowed file list could fail on "file ignored" warnings for files the full
 *     run never lints, so it is never narrowed; it can still be skipped.
 *   - Paths that need shell quoting, or more than MAX_FILES files, run the whole check.
 *
 * RESIDUAL RISK. A shareable config that enables cross-file rules without any of the names above (a
 * company preset wrapping eslint-plugin-import) is treated as per-file. Required CI stays authoritative.
 */

import { posix } from "node:path";
import type { GateCheck } from "./pipeline-steps.js";
import { decideScriptCheck } from "./script-reads.js";

export interface ChangedPath {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface NarrowingInput {
  scripts: Readonly<Record<string, string>>;
  changes: readonly ChangedPath[];
  /** Repository-relative read of the checked-out content; undefined when absent. */
  read: (path: string) => string | undefined;
  /** Every tracked path, for finding nested configuration. Without it nested configs are not looked for. */
  files?: readonly string[];
  /** As in GateDiscoveryOptions: whether `npm run x` also runs `prex`/`postx`. Default true. */
  lifecycleHooks?: boolean;
}

const MAX_FILES = 100;
const MAX_COMMAND = 6000;
const SAFE_PATH = /^[\w./@+-]+$/;
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|json5?|d\.ts)$/;
const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

const ESLINT_CONFIG = /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:js|cjs|json|ya?ml))?|\.eslintignore)$/;
const PRETTIER_CONFIG = /^(?:\.prettierrc(?:\.(?:json5?|ya?ml|toml|[cm]?[jt]s))?|prettier\.config\.[cm]?[jt]s|\.prettierignore|\.editorconfig)$/;
const ESLINT_EXTENSIONS = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"];
const PRETTIER_EXTENSIONS = [...ESLINT_EXTENSIONS, "json", "json5", "css", "scss", "less", "md", "mdx", "yaml", "yml", "html", "vue", "graphql", "gql", "hbs", "handlebars"];
/** Configuration text that turns on rules reading files other than the one being linted. */
const CROSS_FILE = /\bproject(?:Service)?\s*:|TypeChecked|type-checked|\bimport(?:-x)?\/|eslint-plugin-import|import-x|plugin:import|airbnb|boundaries|no-cycle/;

interface Tool {
  name: "eslint" | "prettier";
  valueFlags: Set<string>;
  booleanFlags: Set<string>;
  configs: RegExp;
  extensions: string[];
}

const TOOLS: Record<"eslint" | "prettier", Tool> = {
  eslint: {
    name: "eslint",
    valueFlags: new Set(["--cache-strategy", "--cache-location", "--max-warnings", "--ext", "-c", "--config", "-f", "--format", "--ignore-path", "-o", "--output-file"]),
    booleanFlags: new Set(["--cache", "--quiet", "--fix", "--color", "--no-color", "--no-warn-ignored", "--no-error-on-unmatched-pattern", "--report-unused-disable-directives", "--pass-on-no-patterns"]),
    configs: ESLINT_CONFIG,
    extensions: ESLINT_EXTENSIONS,
  },
  prettier: {
    name: "prettier",
    valueFlags: new Set(["--config", "--ignore-path", "--log-level", "--cache-location", "--cache-strategy", "--end-of-line"]),
    booleanFlags: new Set(["--check", "-c", "--list-different", "-l", "--cache", "--ignore-unknown", "-u", "--no-error-on-unmatched-pattern"]),
    configs: PRETTIER_CONFIG,
    extensions: PRETTIER_EXTENSIONS,
  },
};

interface ParsedCommand {
  tool: Tool;
  /** Everything before the targets, as written. */
  prefix: string[];
  targets: string[];
  values: Map<string, string>;
}

function words(command: string): string[] | undefined {
  const out: string[] = [];
  for (const match of command.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    if (match[3] !== undefined && /["']/.test(match[3])) return undefined;
    out.push(match[0]);
  }
  return out;
}

const unquote = (word: string): string => word.replace(/^(["'])(.*)\1$/, "$2");

function parseCommand(command: string): ParsedCommand | undefined {
  const all = words(command);
  if (!all) return undefined;
  let index = 0;
  if (all[index] === "npx") { index++; if (all[index] === "--no-install") index++; }
  const name = all[index];
  if (name !== "eslint" && name !== "prettier") return undefined;
  const tool = TOOLS[name];
  const prefix = all.slice(0, ++index);
  const values = new Map<string, string>();
  const targets: string[] = [];
  for (; index < all.length; index++) {
    const word = all[index]!;
    if (word.startsWith("-")) {
      if (targets.length) return undefined;
      const [flag, inline] = word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
      if (tool.booleanFlags.has(flag)) { prefix.push(word); continue; }
      if (!tool.valueFlags.has(flag)) return undefined;
      const value = inline ?? all[++index];
      if (value === undefined) return undefined;
      values.set(flag, unquote(value));
      prefix.push(...(inline === undefined ? [word, value] : [word]));
      continue;
    }
    targets.push(unquote(word));
  }
  if (targets.length === 0 || targets.some((target) => target.startsWith("!"))) return undefined;
  if (tool.name === "prettier" && !["--check", "-c", "--list-different", "-l"].some((flag) => prefix.includes(flag))) return undefined;
  return { tool, prefix, targets, values };
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  return match[1]!.split(",").flatMap((alternative) => expandBraces(pattern.slice(0, match.index) + alternative + pattern.slice(match.index + match[0].length)));
}

function globMatches(pattern: string, path: string): boolean {
  return expandBraces(pattern.replace(/^\.\//, "")).some((p) => {
    const source = p.replace(/[.+^$()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\0A").replace(/\*\*/g, "\0B").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
      .replace(/\0A/g, "(?:.*/)?").replace(/\0B/g, ".*");
    return new RegExp(`^${source}$`).test(path);
  });
}

function covers(target: string, path: string, extensions: readonly string[]): boolean {
  if (/[*?{[]/.test(target)) return globMatches(target, path);
  const normalized = posix.normalize(target).replace(/\/$/, "");
  if (normalized === path) return true;
  const inside = normalized === "." || path.startsWith(`${normalized}/`);
  return inside && extensions.includes(posix.extname(path).slice(1));
}

/** Root configuration files of the tool that exist, and the paths each one names relatively. */
function configReferences(tool: Tool, input: NarrowingInput, explicit: string | undefined): { texts: string[]; referenced: string[] } {
  const candidates = explicit ? [posix.normalize(explicit)] : tool.name === "eslint"
    ? ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yaml", ".eslintrc.yml", ".eslintrc"]
    : [];
  const texts: string[] = [];
  const referenced: string[] = [];
  for (const path of candidates) {
    const text = input.read(path);
    if (text === undefined) continue;
    texts.push(text);
    for (const match of text.matchAll(/["'`](\.{1,2}\/[^"'`\s]+)["'`]/g)) {
      const ref = posix.normalize(posix.join(posix.dirname(path), match[1]!));
      // A local plugin's entry file imports its siblings, so its whole directory counts.
      referenced.push(ref, ...(posix.extname(ref) && posix.dirname(ref) !== "." ? [posix.dirname(ref)] : []));
    }
  }
  if (tool.name === "eslint") {
    const manifest = input.read("package.json");
    try {
      const embedded = manifest === undefined ? undefined : (JSON.parse(manifest) as { eslintConfig?: unknown }).eslintConfig;
      if (embedded !== undefined) texts.push(JSON.stringify(embedded));
    } catch { /* package.json changes already run the whole check */ }
  }
  return { texts, referenced };
}

function decide(check: GateCheck, input: NarrowingInput): GateCheck {
  if (check.kind !== "lint" && check.kind !== "format") return check;
  const hooks = input.lifecycleHooks !== false;
  if (check.runsScript && hooks && (input.scripts[`pre${check.script}`] !== undefined || input.scripts[`post${check.script}`] !== undefined)) return check;
  const parsed = parseCommand(check.command);
  if (!parsed) return check;
  const { tool, prefix, targets, values } = parsed;
  const run = (reason: string): GateCheck => ({ ...check, decision: "RUN", reason });
  const skip = (reason: string): GateCheck => ({ ...check, decision: "SKIP", reason });

  const explicitConfig = values.get("-c") ?? values.get("--config");
  const ignorePath = values.get("--ignore-path");
  const { texts, referenced } = configReferences(tool, input, explicitConfig);
  const configChange = input.changes.find(({ path }) => {
    const base = posix.basename(path);
    return tool.configs.test(base) || LOCKFILE.test(base) || path === "package.json"
      || path === explicitConfig || path === ignorePath || (tool.name === "eslint" && base === ".gitignore")
      || referenced.some((ref) => path === ref || path.startsWith(`${ref}/`) || path.startsWith(`${ref}.`));
  });
  if (configChange) return run(`${configChange.path} changed: runs the whole ${tool.name} check`);

  const extensions = tool.name === "eslint" && values.has("--ext")
    ? [...ESLINT_EXTENSIONS, ...values.get("--ext")!.split(",").map((ext) => ext.replace(/^\./, ""))]
    : tool.extensions;
  if (tool.name === "eslint") {
    const nested = input.files?.find((path) => path.includes("/") && ESLINT_CONFIG.test(posix.basename(path)) && !posix.basename(path).endsWith("ignore"));
    const crossFile = nested !== undefined || texts.length === 0 || texts.some((text) => CROSS_FILE.test(text));
    if (crossFile) {
      const why = nested ? `nested ESLint config ${nested}` : texts.length === 0 ? "no root ESLint config found" : "type-aware or cross-file ESLint rules";
      const code = input.changes.find(({ path }) => CODE.test(path));
      return code ? run(`${why}: lints the whole target because ${code.path} changed`) : skip(`${why}, but no code file changed`);
    }
    const deleted = input.changes.find(({ path, status }) => status === "deleted" && CODE.test(path));
    if (deleted) return run(`${deleted.path} was deleted: an import of it may break in a file that remains`);
  }

  const files = input.changes.filter(({ path, status }) => status !== "deleted" && targets.some((target) => covers(target, path, extensions))).map(({ path }) => path);
  if (files.length === 0) return skip(`no changed file is in ${targets.join(" ")}`);
  if (tool.name === "eslint" && values.has("--max-warnings")) return run("--max-warnings: a narrowed file list could warn about files the full run ignores");
  if (files.length > MAX_FILES || files.some((path) => !SAFE_PATH.test(path))) return run(`${files.length} changed file(s) in the target; runs the whole check`);
  const command = [...prefix, ...files].join(" ");
  if (command.length > MAX_COMMAND) return run("the narrowed command would be too long; runs the whole check");
  return { ...check, runsScript: false, command, decision: "NARROWED", reason: `${files.length} changed file(s) in ${targets.join(" ")}` };
}

/** Narrows or skips each lint and format check, and runs or skips each repository-script check
 * (script-reads.ts), for this change; other checks are returned unchanged. */
export function narrowGateChecks(checks: readonly GateCheck[], input: NarrowingInput): GateCheck[] {
  // A whole-script leaf's command is the script body, so the same parse applies; a RUN keeps running the
  // script as written.
  return checks.map((check) => (check.kind === "script" ? decideScriptCheck(check, input) : decide(check, input)));
}
