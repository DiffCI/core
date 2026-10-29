// SPDX-License-Identifier: MIT
/**
 * The repository's gate as a list of checks (2026-10-29, docs/design/pipeline-impact.md, phase 1 slice 1).
 *
 * WHY. On one dogfood repository 104 pushes passed whatever the agent ran locally and then failed the
 * gate (`npm run check`: typecheck, lint, an architecture-boundary script, ...) after push. Agents ran the
 * tests DiffCI selected, or `tsc`, and never the rest. Test selection cannot catch those failures because
 * they are not tests. This module names every leaf of the gate so verification can run them.
 *
 * THE RULE. The gate is the `check` script, else `validate`, else the conventional typecheck, lint and
 * format scripts that exist; plus every check-named script (`check*`, `lint*`, `typecheck`, `validate*`)
 * a CI workflow step runs. In the dogfood repository the architecture rule behind one of the 104 failures
 * runs in `validate:release`, which a deploy workflow calls and `check` does not. A gate script is expanded into leaves: `a && b` and `a ; b` parts, `npm run x`
 * (with x's pre/post hooks), `run-p`/`run-s`/`npm-run-all` script lists and globs, `concurrently` with
 * `npm:x` or quoted commands, and a repository runner whose every argument is a script name
 * (`node scripts/run-parallel.mjs lint:a check:b`).
 *
 * FAILING CLOSED. A script whose body cannot be split safely (`||`, pipes, redirects, subshells, variables,
 * environment assignments, unknown arguments) stays one leaf, run as `npm run <script>`, so it runs exactly
 * as the gate would. Leaves that run a test runner are left to test selection. Every leaf is RUN: nothing is
 * narrowed or skipped yet (slices 2-4 in the design).
 */

import { parse } from "yaml";

export type GateCheckKind = "typecheck" | "lint" | "format" | "script" | "unknown";

export interface GateCheck {
  /** The script name when the leaf is a whole script, `script[n]` for the n-th part of one. */
  id: string;
  /** The package script the leaf belongs to. */
  script: string;
  /** True: run the whole script (`npm run <script>`, which also runs its hooks). False: `command` is one
   * part of the script's body, run on its own. */
  runsScript: boolean;
  /** The leaf as written: the script body when `runsScript`, otherwise the part. */
  command: string;
  kind: GateCheckKind;
  decision: "RUN";
  reason: string;
}

export interface GateDiscovery {
  /** The scripts the gate was read from, in order. Empty when the repository declares none. */
  roots: string[];
  checks: GateCheck[];
  /** Leaves that run a test runner; test selection covers them. */
  coveredByTests: string[];
}

const GATE_FALLBACK_ROOTS = ["typecheck", "type-check", "types", "tsc", "lint", "format:check", "prettier:check", "fmt:check"];
const MAX_DEPTH = 10;
/** Workflow-run scripts that are checks by name. Anything else a workflow runs (build, deploy, release,
 * migrations) is never run locally on the strength of a workflow naming it. */
const CHECK_NAME = /^(?:check|checks|lint|typecheck|type-check|types|tsc|validate|format:check|prettier:check|fmt:check)(?::[\w:.-]+)?$/;
const WORKFLOW_SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g;

const SCRIPT_RUN = /^(npm|pnpm|yarn|bun)\s+(?:(?:run|run-script)\s+)?([\w:.@/-]+)$/;
const NPM_BUILTINS = new Set(["test", "start", "stop", "restart"]);
const RUN_ALL = /^(?:npx\s+(?:--no-install\s+)?)?(?:run-p|run-s|npm-run-all2?)\b(.*)$/;
const CONCURRENTLY = /^(?:npx\s+(?:--no-install\s+)?)?concurrently\b(.*)$/;
const REPO_RUNNER = /^(?:node|tsx|bun)\s+(\.{0,2}\/?[\w./-]+\.(?:m?[jt]s|c[jt]s))((?:\s+[\w:.@/-]+)+)$/;
/** Shell syntax whose meaning changes when the script is split into parts or run outside its shell. */
const UNSPLITTABLE = /\|\||[|<>`$()\\]|^\s*\w+=|\s\w+=\S/;
const TEST_RUNNER = /(?:^|[\s/])(?:vitest|jest|mocha|ava|tap|playwright|cypress|karma|jasmine)(?:\s|$)|(?:node|tsx|bun|deno)(?:\s+--?[\w-]+(?:=\S+)?)*\s+--test\b|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/;

function kindOf(command: string): GateCheckKind {
  if (/(?:^|[\s/])(?:tsc|vue-tsc|svelte-check|tsgo)(?:\s|$)/.test(command)) return "typecheck";
  if (/(?:^|[\s/])prettier\b.*--(?:check|list-different)\b|(?:^|[\s/])(?:biome|dprint)\s+(?:format|check)\b/.test(command)) return "format";
  if (/(?:^|[\s/])(?:eslint|biome|oxlint|stylelint|xo|standard|markdownlint(?:-cli2)?)(?:\s|$)/.test(command)) return "lint";
  if (/^(?:node|tsx|ts-node|bun|deno\s+run|python3?|bash|sh)\s+\S/.test(command)) return "script";
  return "unknown";
}

/** Splits on top-level `&&` and `;`. Undefined when the body needs its shell (see UNSPLITTABLE). */
function splitParts(body: string): string[] | undefined {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === "'" || char === "\"") {
      quote = char;
      current += char;
    } else if (char === ";" || (char === "&" && body[i + 1] === "&")) {
      parts.push(current.trim());
      current = "";
      if (char === "&") i++;
    } else {
      if (char === "&") return undefined;
      current += char;
    }
  }
  if (quote) return undefined;
  parts.push(current.trim());
  const unquoted = parts.map((part) => part.replace(/"[^"]*"|'[^']*'/g, "\"\""));
  // A double-quoted `$` or backtick still expands in the shell.
  if (parts.some((part) => !part || /"[^"]*[$`][^"]*"/.test(part)) || unquoted.some((part) => UNSPLITTABLE.test(part))) return undefined;
  return parts;
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^:]*")}$`);
}

/** Script names a part runs, or undefined when the part is not only a list of scripts. */
function scriptsRunBy(part: string, scripts: Readonly<Record<string, string>>): string[] | undefined {
  const direct = SCRIPT_RUN.exec(part);
  if (direct) {
    const [, manager, name] = direct;
    if (manager === "npm" && !/\brun(?:-script)?\s/.test(part) && !NPM_BUILTINS.has(name!)) return undefined;
    return scripts[name!] !== undefined ? [name!] : undefined;
  }
  const runAll = RUN_ALL.exec(part);
  if (runAll) {
    const names: string[] = [];
    for (const word of runAll[1]!.trim().split(/\s+/).filter(Boolean)) {
      if (/^-(?:p|s|l|c|-parallel|-sequential|-serial|-print-label|-continue-on-error|-print-name|-silent)$/.test(word)) continue;
      const pattern = word.replace(/^["']|["']$/g, "");
      if (pattern.startsWith("-")) return undefined;
      const matched = /[*]/.test(pattern) ? Object.keys(scripts).filter((name) => globToRegExp(pattern).test(name)) : scripts[pattern] !== undefined ? [pattern] : [];
      if (matched.length === 0) return undefined;
      names.push(...matched);
    }
    return names.length ? names : undefined;
  }
  const runner = REPO_RUNNER.exec(part);
  if (runner) {
    const names = runner[2]!.trim().split(/\s+/);
    return names.every((name) => scripts[name] !== undefined) ? names : undefined;
  }
  return undefined;
}

/** `concurrently "npm:a" "eslint ."`: the quoted commands, or undefined when any argument is not one. */
function concurrentlyParts(part: string): string[] | undefined {
  const match = CONCURRENTLY.exec(part);
  if (!match) return undefined;
  const args = match[1]!.trim();
  const commands = [...args.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2] ?? "").trim());
  const rest = args.replace(/"[^"]*"|'[^']*'/g, "").trim();
  if (rest || commands.length === 0 || commands.some((command) => !command)) return undefined;
  return commands.map((command) => (command.startsWith("npm:") ? `npm run ${command.slice(4)}` : command));
}

/** A leaf that only runs a test runner. A body that mixes tests with other work stays a check. */
function onlyRunsTests(command: string): boolean {
  const parts = splitParts(command);
  return parts?.length === 1 && TEST_RUNNER.test(parts[0]!);
}

/**
 * Check-named package scripts that GitHub Actions steps run, in workflow order. Disabled jobs (`if: false`)
 * and workflows that do not parse contribute nothing: these only add checks, so missing one is the
 * pre-existing behaviour rather than a wrong skip.
 */
export function workflowGateScripts(workflowTexts: readonly string[], scripts: Readonly<Record<string, string>>): string[] {
  const names: string[] = [];
  for (const text of workflowTexts) {
    let jobs: unknown;
    try { jobs = (parse(text) as { jobs?: unknown } | null)?.jobs; } catch { continue; }
    if (!jobs || typeof jobs !== "object") continue;
    for (const job of Object.values(jobs as Record<string, unknown>)) {
      if (!job || typeof job !== "object") continue;
      const { steps, if: condition } = job as { steps?: unknown; if?: unknown };
      if (condition === false || (typeof condition === "string" && /^\s*(?:\$\{\{\s*)?false(?:\s*\}\})?\s*$/.test(condition))) continue;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        const run = (step as { run?: unknown } | null)?.run;
        if (typeof run !== "string") continue;
        for (const match of run.matchAll(WORKFLOW_SCRIPT)) {
          const name = match[1]!;
          if (CHECK_NAME.test(name) && scripts[name] !== undefined && !names.includes(name)) names.push(name);
        }
      }
    }
  }
  return names;
}

export interface GateDiscoveryOptions {
  /** Further gate scripts, such as `workflowGateScripts`; expanded after the package's own gate. */
  workflowScripts?: readonly string[];
  /** Whether the package manager runs `pre<name>`/`post<name>` scripts (npm and Yarn 1 do; pnpm does
   * not by default). Default true. */
  lifecycleHooks?: boolean;
}

/** Finds the gate's scripts and expands them into leaf checks. Reads nothing but `scripts`. */
export function discoverGateChecks(scripts: Readonly<Record<string, string>>, options: GateDiscoveryOptions = {}): GateDiscovery {
  const hooks = options.lifecycleHooks !== false;
  const packageRoots = scripts["check"] !== undefined ? ["check"]
    : scripts["validate"] !== undefined ? ["validate"]
      : GATE_FALLBACK_ROOTS.filter((name) => scripts[name] !== undefined);
  const roots = [...packageRoots, ...(options.workflowScripts ?? []).filter((name) => scripts[name] !== undefined && !packageRoots.includes(name))];
  const checks: GateCheck[] = [];
  const coveredByTests: string[] = [];
  const seen = new Set<string>();

  const add = (check: Omit<GateCheck, "kind" | "decision">): void => {
    if (seen.has(check.id)) return;
    seen.add(check.id);
    if (onlyRunsTests(check.command)) { coveredByTests.push(check.id); return; }
    checks.push({ ...check, kind: kindOf(check.command), decision: "RUN", reason: `${check.reason}; always run (not yet narrowed)` });
  };

  const whole = (script: string, reason: string): void => add({ id: script, script, runsScript: true, command: scripts[script]!, reason });

  const expand = (script: string, stack: readonly string[], reason: string): void => {
    if (stack.includes(script) || stack.length >= MAX_DEPTH) { whole(script, reason); return; }
    const body = scripts[script]!;
    const parts = splitParts(body);
    const inner = parts?.map((part) => ({ part, names: scriptsRunBy(part, scripts), concurrent: concurrentlyParts(part) }));
    const reducible = inner && (inner.length > 1 || inner.some((p) => p.names || p.concurrent));
    if (!reducible) { whole(script, reason); return; }
    const next = [...stack, script];
    if (hooks && scripts[`pre${script}`] !== undefined) expand(`pre${script}`, next, `runs before ${script}`);
    inner.forEach(({ part, names, concurrent }, index) => {
      if (names) {
        for (const name of names) expand(name, next, `run by ${script}`);
      } else if (concurrent) {
        concurrent.forEach((command, n) => {
          const named = scriptsRunBy(command, scripts);
          if (named) for (const name of named) expand(name, next, `run by ${script}`);
          else add({ id: `${script}[${index + 1}.${n + 1}]`, script, runsScript: false, command, reason: `part of ${script}` });
        });
      } else {
        add({ id: `${script}[${index + 1}]`, script, runsScript: false, command: part, reason: `part of ${script}` });
      }
    });
    if (hooks && scripts[`post${script}`] !== undefined) expand(`post${script}`, next, `runs after ${script}`);
  };

  for (const root of roots) {
    expand(root, [], !packageRoots.includes(root) ? `${root}, run by a CI workflow` : GATE_FALLBACK_ROOTS.includes(root) ? "a conventional gate script" : `the ${root} gate`);
  }
  return { roots, checks, coveredByTests };
}
