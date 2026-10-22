// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which discovered test files does `npm test` actually run? (2026-10-21, dogfood telemetry.)
 *
 * WHY. Discovery reports every `*.test.*` file. One dogfood repository has 725; its `npm test` runs 548. The
 * other 177 are real tests owned by other scripts (`test:d1-migration`, `test:ci-evidence`). DiffCI
 * selected them, so 13 of 53 paired runs failed with "Selection falls outside the frozen full
 * universe": the selective arm executed files the full arm never runs, which is not a comparison of
 * two ways to run one suite. The receipts also over-reported the suite size.
 *
 * THE MODEL. The test script (with pretest/posttest, and any `npm run x` it calls) is split into `&&`
 * phases. Each phase must be one of:
 *   - a node:test runner (`node --test`, `tsx --test`, with flags): its positional paths, directories
 *     and globs name the files it runs; with none, node's default discovery runs everything;
 *   - an interpreter running one repository file (`node scripts/test-security.js`): an OPAQUE phase.
 *     It runs a discovered test only by importing it (its graph closure) or by handing it to an
 *     import()/require()/spawn/exec/Worker call whose argument names the test or one of its
 *     directories;
 *   - a recognised tool that executes no repository tests (`tsc`, `eslint`, `prettier`).
 * Anything else - another runner, a pipeline, `||`, a subshell, an unknown binary - leaves the model
 * incomplete, and an incomplete model narrows nothing.
 *
 * THE SAFETY DIRECTION is the one src/repo/runner-universe.ts states: hiding a test the full command
 * runs is the dangerous error, so every ambiguity widens the universe or abandons the model. A test the
 * model excludes is not dropped either. It is reported as outside the full suite and still run when
 * affected; it just is not presented as part of the full suite.
 */
import { matchesGlob } from "./test-discovery.js";
import { referencePattern, referenceTokens } from "./file-references.js";

export interface ScriptUniverseInput {
  scripts: Readonly<Record<string, string>>;
  discoveredTests: readonly string[];
  /** Transitive imports of a repository file, from the dependency graph. */
  dependenciesOf: (path: string) => readonly string[];
  read: (path: string) => string | undefined;
  exists: (path: string) => boolean;
}

export interface ScriptUniverse {
  /** False when any phase was not understood; `tests` is then every discovered test. */
  complete: boolean;
  reason?: string;
  tests: string[];
}

const NODE_TEST_VALUE_FLAGS = new Set(["--conditions", "-C", "--import", "--require", "-r", "--loader", "--experimental-loader", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout", "--env-file", "--tsconfig"]);
const NON_EXECUTING_TOOLS = new Set(["tsc", "eslint", "prettier", "biome", "stylelint", "markdownlint", "cspell", "knip", "publint", "attw"]);
const INTERPRETERS = new Set(["node", "tsx", "ts-node", "bun"]);
const EXECUTING_CALL = /\b(?:import|require|spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|execa|execaNode|Worker)\s*\(/g;

function shellWords(phase: string): string[] | undefined {
  if (/[|;`<>\n]|\$\(|\|\|/.test(phase.replace(/"[^"]*"|'[^']*'/g, ""))) return undefined;
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of phase.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words;
}

function expandScript(name: string, scripts: Readonly<Record<string, string>>, depth = 0): string[] | undefined {
  if (depth > 5) return undefined;
  const body = scripts[name];
  if (typeof body !== "string") return undefined;
  const phases: string[] = [];
  for (const hook of [`pre${name}`, name, `post${name}`]) {
    if (hook !== name && typeof scripts[hook] !== "string") continue;
    for (const phase of (hook === name ? body : scripts[hook]!).split(/\s*&&\s*/)) {
      const words = shellWords(phase.trim());
      const nested = words && /^(?:npm|pnpm|yarn|bun)$/.test(words[0] ?? "")
        ? (words[1] === "run" || words[1] === "run-script" ? words[2] : words[1] === "test" || words[1] === "t" ? "test" : undefined)
        : undefined;
      if (nested && words!.length <= (words![1] === "run" || words![1] === "run-script" ? 3 : 2)) {
        if (nested === name) return undefined;
        const expanded = expandScript(nested, scripts, depth + 1);
        if (!expanded) return undefined;
        phases.push(...expanded);
      } else phases.push(phase.trim());
    }
  }
  return phases;
}

/** Arguments of every call that could execute another module, from one file's text. */
function executingArguments(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(EXECUTING_CALL)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (index < text.length && depth > 0 && index - start < 2000) {
      const ch = text[index++];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    args.push(text.slice(start, index));
  }
  return args;
}

/** Models the files `npm test` runs. See the module comment for the rules and their direction. */
export function modelTestScriptUniverse(input: ScriptUniverseInput): ScriptUniverse {
  const everything = (reason: string): ScriptUniverse => ({ complete: false, reason, tests: [...input.discoveredTests].sort() });
  const phases = expandScript("test", input.scripts);
  if (!phases) return everything("the test script could not be expanded into && phases");
  const discovered = new Set(input.discoveredTests);
  const universe = new Set<string>();
  for (const phase of phases) {
    const words = shellWords(phase);
    if (!words || words.length === 0) return everything(`phase not understood: ${phase}`);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    if (words[0] === "cross-env") { words.shift(); while (words.length && /=/.test(words[0]!)) words.shift(); }
    if (words[0] === "npx" && words[1] === "--no-install") words.splice(0, 2);
    else if (words[0] === "npx") words.shift();
    const executable = words[0] ?? "";
    if (NON_EXECUTING_TOOLS.has(executable)) continue;
    if (!INTERPRETERS.has(executable)) return everything(`phase runs ${executable || "nothing"}, which is not modelled`);
    const positional: string[] = [];
    let isTestRunner = false;
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!;
      if (word === "--test") { isTestRunner = true; continue; }
      if (word.startsWith("-")) {
        if (!word.includes("=") && NODE_TEST_VALUE_FLAGS.has(word)) i++;
        continue;
      }
      positional.push(word.replace(/^\.\//, ""));
    }
    if (isTestRunner) {
      if (positional.length === 0) return { complete: true, tests: [...input.discoveredTests].sort() };
      for (const arg of positional) {
        const matched = input.discoveredTests.filter((path) => path === arg || path.startsWith(`${arg.replace(/\/$/, "")}/`) || (/[*?{[]/.test(arg) && matchesGlob(path, arg)));
        if (matched.length === 0 && !/[*?{[]/.test(arg) && input.exists(arg) && !discovered.has(arg)) {
          return everything(`the test script runs ${arg}, which discovery does not recognise as a test`);
        }
        for (const path of matched) universe.add(path);
      }
      continue;
    }
    // An opaque phase: one repository file run by an interpreter.
    const script = positional[0];
    if (!script || positional.length > 1 && !input.exists(script)) return everything(`phase not understood: ${phase}`);
    if (!input.exists(script)) return everything(`phase runs ${script}, which does not exist`);
    const closure = [script, ...input.dependenciesOf(script)];
    for (const path of closure) if (discovered.has(path)) universe.add(path);
    const callArguments = closure.flatMap((path) => executingArguments(input.read(path) ?? ""));
    if (callArguments.length === 0) continue;
    // Spawning a test runner can run files no argument names (node --test with default discovery).
    if (callArguments.some((args) => /--test\b|\b(?:vitest|jest|mocha|ava|playwright)\b/.test(args))) {
      return everything(`${script} starts a test runner`);
    }
    for (const test of input.discoveredTests) {
      if (universe.has(test)) continue;
      const pattern = referencePattern(referenceTokens(test));
      if (callArguments.some((args) => pattern.test(args))) universe.add(test);
    }
  }
  return { complete: true, tests: [...universe].sort() };
}
