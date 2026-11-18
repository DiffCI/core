// SPDX-License-Identifier: MIT
/**
 * Python gate checks read from CI workflows (2026-11-18).
 *
 * WHY. The gate (pipeline-steps.ts) is read from package.json scripts, so a Python repository had no
 * checks at all. A sweep of public CI history found PRs that went red only on a Python type check: in
 * langgenius/dify, 4 of 28 red PRs failed only in `make type-check-core` (pyrefly), each on a file the PR
 * changed. Test selection cannot catch those. This module names the Python checks CI runs so verify can
 * run them before the push.
 *
 * THE RULE. A check is a GitHub Actions `run` line that is exactly one of:
 *
 *   - `make [-C dir] <target>` where the target is check-named (`check*`, `lint*`, `type-check*`,
 *     `typecheck*`, `mypy*`, `pyright*`, `pyrefly*`, `ruff*`, `validate*`) and the Makefile defines it with
 *     a recipe that does not rewrite files (`--fix`, `ruff format` or `black`/`isort` without a check flag);
 *   - a direct `mypy`, `pyright`, `basedpyright`, `pyrefly check`, `ruff check` or `ruff format --check`
 *     call, optionally behind `uv run`, `poetry run`, `pdm run`, `hatch run`, `pipenv run` or `python -m`,
 *     whose every argument is a plain word and none rewrites files or writes output.
 *
 * FAILING CLOSED. Here that means adding nothing: anything not read with certainty is left out, which
 * is the behaviour before this module. Steps in disabled jobs, steps with expressions in their working
 * directory, blocks that change directory or environment (`cd`, `source`, `export`, line continuations),
 * and lines with shell syntax or `${{ }}` contribute nothing. A direct call in a step with a working
 * directory other than the root is left out; `make` takes it through `-C`.
 *
 * NARROWING. A check is "Python-only" when it is a direct tool call, or a make target with no
 * prerequisites whose recipe lines are only `echo`, Python tool calls, or repository scripts that call a
 * Python tool and no JavaScript tool. A Python-only check is skipped when no changed path is a Python
 * file, Python configuration, the Makefile or a script it runs, or a workflow file. Every other check
 * runs as written.
 */

import { posix } from "node:path";
import { parse } from "yaml";
import type { ChangedPath } from "./check-narrowing.js";
import type { GateCheck } from "./pipeline-steps.js";

export interface PythonCheck extends GateCheck {
  /** True when the check only runs Python tools, so a change without Python files cannot fail it. */
  pythonOnly: boolean;
  /** Repository paths besides Python files and configuration whose change runs the check. */
  triggers: string[];
}

export interface WorkflowFile {
  /** Repository-relative path, such as `.github/workflows/style.yml`. */
  path: string;
  text: string;
}

const MAKE_LINE = /^make(?:\s+-C\s+([\w./-]+))?\s+([\w.-]+)$/;
const CHECK_TARGET = /^(?:check|checks|lint|typecheck|type-check|types|mypy|pyright|pyrefly|ruff|validate)(?:[-_:][\w.-]+)?$/;
const RUNNER_PREFIX = /^(?:uv\s+run(?:\s+--(?:project|directory|group|extra|python)(?:=|\s+)[\w./-]+|\s+--(?:dev|frozen|locked|no-sync|all-extras|all-groups|isolated))*\s+|(?:poetry|pdm|hatch|pipenv)\s+run\s+|python3?\s+-m\s+)?/;
const TOOL = /^(mypy|pyright|basedpyright|pyrefly\s+check|ruff\s+check|ruff\s+format)(?=\s|$)/;
const SAFE_ARG = /^[\w./@:=,+-]+$/;
const REWRITING_ARG = /^(?:--fix|--fix-only|--unsafe-fixes|--watch|--install-types|--write|-o|--output|--output-file|--junit-xml|--html-report|--txt-report|--xml-report|--linecount-report|--cobertura-xml-report)(?:=|$)/;
const CONTEXT_CHANGE = /^(?:cd|pushd|popd|source|\.|export|set|unset|alias)\s|\\$/;
const PY_TOOL = /\b(?:mypy|pyright|basedpyright|pyrefly|ruff|pylint|flake8|black|isort|pytype|lint-imports)\b/;
const JS_TOOL = /\b(?:npm|npx|pnpm|yarn|node|tsc|eslint|prettier|bun|deno|vp|turbo|nx)\b/;
const PY_FILE = /\.(?:py|pyi|pyx|pxd|ipynb)$/;
const PY_CONFIG = /^(?:pyproject\.toml|setup\.cfg|setup\.py|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|pyrefly\.toml|ruff\.toml|\.ruff\.toml|tox\.ini|uv\.lock|poetry\.lock|pdm\.lock|Pipfile|Pipfile\.lock|\.python-version|py\.typed|(?:requirements|constraints)[\w.-]*\.(?:txt|in))$/;
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];

function normalizeDir(dir: string): string | undefined {
  if (/\$\{\{|\.\.|^\//.test(dir)) return undefined;
  const normalized = posix.normalize(dir.replace(/\\/g, "/")).replace(/\/+$/, "");
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

function workingDirectory(...levels: unknown[]): string | undefined {
  for (const level of levels) {
    const dir = (level as { "working-directory"?: unknown } | undefined)?.["working-directory"];
    if (dir === undefined) continue;
    return typeof dir === "string" ? normalizeDir(dir) : undefined;
  }
  return "";
}

function disabled(condition: unknown): boolean {
  return condition === false || (typeof condition === "string" && /^\s*(?:\$\{\{\s*)?false(?:\s*\}\})?\s*$/.test(condition));
}

/** Rewrites files, so never run as a check: fixers and formatters without a check flag. */
function rewrites(line: string): boolean {
  if (/(?:^|\s)--(?:fix|fix-only|unsafe-fixes)\b/.test(line)) return true;
  if (/\bruff\s+format\b/.test(line) && !/\s--(?:check|diff)\b/.test(line)) return true;
  if (/\bblack\b/.test(line) && !/\s--(?:check|diff)\b/.test(line)) return true;
  if (/\bisort\b/.test(line) && !/\s(?:--check|--check-only|--diff|-c)\b/.test(line)) return true;
  return false;
}

/** A direct Python tool call, normalized, with its kind; undefined when the line is anything else. */
export function directToolCall(line: string): { command: string; kind: GateCheck["kind"] } | undefined {
  const command = line.trim().replace(/\s+/g, " ");
  const prefix = RUNNER_PREFIX.exec(command)![0];
  const rest = command.slice(prefix.length);
  const tool = TOOL.exec(rest);
  if (!tool) return undefined;
  const args = rest.slice(tool[0].length).trim().split(" ").filter(Boolean);
  if (args.some((arg) => !SAFE_ARG.test(arg) || REWRITING_ARG.test(arg))) return undefined;
  const name = tool[1]!.replace(/\s+/, " ");
  if (name === "ruff format" && !args.some((arg) => arg === "--check" || arg === "--diff")) return undefined;
  const kind = name === "ruff check" ? "lint" : name === "ruff format" ? "format" : "typecheck";
  return { command, kind };
}

interface MakeTarget { path: string; prerequisites: string; recipe: string[] }

function makeTarget(dir: string, target: string, read: (path: string) => string | undefined): MakeTarget | undefined {
  for (const name of MAKEFILES) {
    const path = dir ? `${dir}/${name}` : name;
    const text = read(path);
    if (text === undefined) continue;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const escaped = target.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const header = new RegExp(`^(?:[\\w.-]+\\s+)*${escaped}(?:\\s+[\\w.-]+)*\\s*:(?![:=])(.*)$`);
    const at = lines.findIndex((line) => header.test(line));
    if (at < 0) return undefined;
    const prerequisites = header.exec(lines[at]!)![1]!.replace(/#.*$/, "").trim();
    const recipe: string[] = [];
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("\t")) { recipe.push(line.slice(1).trim()); continue; }
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      break;
    }
    return { path, prerequisites, recipe: recipe.filter((line) => line && !line.startsWith("#")) };
  }
  return undefined;
}

/** True when every recipe line is an echo, a Python tool call, or a repository script that calls a Python
 * tool and no JavaScript tool; also returns those scripts. Undefined when any line is something else. */
function pythonOnlyRecipe(target: MakeTarget, dir: string, read: (path: string) => string | undefined): string[] | undefined {
  if (target.prerequisites.includes(";")) return undefined;
  const scripts: string[] = [];
  let usesPython = false;
  for (const raw of target.recipe) {
    const line = raw.replace(/^[@+-]+/, "").trim();
    if (/\$\(MAKE\)|\$\{MAKE\}|(?:^|\s)make\s/.test(line)) return undefined;
    if (/^(?:echo\b|printf\b|true$|:$)/.test(line)) continue;
    if (JS_TOOL.test(line)) return undefined;
    const script = /^(?:(?:bash|sh)\s+)?(\.?\/?[\w./-]+)(?:\s|$)/.exec(line)?.[1];
    if (directToolCall(line.replace(/\s+\$\([\w]+\)/g, ""))) { usesPython = true; continue; }
    if (script && script.includes("/")) {
      const path = posix.normalize(posix.join(dir, script.replace(/^\.\//, "")));
      const text = path.startsWith("..") ? undefined : read(path);
      if (text === undefined || JS_TOOL.test(text) || !PY_TOOL.test(text)) return undefined;
      scripts.push(path);
      usesPython = true;
      continue;
    }
    return undefined;
  }
  return usesPython ? scripts : undefined;
}

function makeKind(target: string, recipe: readonly string[]): GateCheck["kind"] {
  if (/type|mypy|pyright|pyrefly/.test(target)) return "typecheck";
  if (/lint|ruff/.test(target)) return "lint";
  const text = recipe.join("\n");
  if (/\b(?:mypy|pyright|basedpyright|pyrefly)\b/.test(text)) return "typecheck";
  if (/\b(?:ruff\s+check|pylint|flake8)\b/.test(text)) return "lint";
  return "script";
}

/**
 * The Python checks CI workflows run, in workflow order. Reads the workflows and, through `read`, the
 * Makefiles and scripts they name. Every check starts as RUN.
 */
export function discoverPythonChecks(workflows: readonly WorkflowFile[], read: (path: string) => string | undefined): PythonCheck[] {
  const checks: PythonCheck[] = [];
  const seen = new Set<string>();
  for (const workflow of workflows) {
    let doc: { jobs?: unknown; defaults?: { run?: unknown } } | null;
    try { doc = parse(workflow.text) as typeof doc; } catch { continue; }
    if (!doc?.jobs || typeof doc.jobs !== "object") continue;
    for (const job of Object.values(doc.jobs as Record<string, unknown>)) {
      if (!job || typeof job !== "object") continue;
      const { steps, if: condition, defaults } = job as { steps?: unknown; if?: unknown; defaults?: { run?: unknown } };
      if (disabled(condition) || !Array.isArray(steps)) continue;
      for (const step of steps) {
        const { run, if: stepCondition } = (step ?? {}) as { run?: unknown; if?: unknown };
        if (typeof run !== "string" || disabled(stepCondition)) continue;
        const dir = workingDirectory(step, defaults?.run, doc.defaults?.run);
        if (dir === undefined) continue;
        const lines = run.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
        if (lines.some((line) => CONTEXT_CHANGE.test(line) || line.includes("${{"))) continue;
        for (const line of lines) {
          const check = makeCheck(line, dir, workflow.path, read) ?? (dir === "" ? toolCheck(line, workflow.path) : undefined);
          if (!check || seen.has(check.command)) continue;
          seen.add(check.command);
          checks.push(check);
        }
      }
    }
  }
  return checks;
}

function makeCheck(line: string, stepDir: string, workflowPath: string, read: (path: string) => string | undefined): PythonCheck | undefined {
  const match = MAKE_LINE.exec(line.replace(/\s+/g, " "));
  if (!match) return undefined;
  const [, cDir, target] = match;
  if (!CHECK_TARGET.test(target!)) return undefined;
  const dir = normalizeDir(posix.join(stepDir || ".", cDir ?? "."));
  if (dir === undefined) return undefined;
  const found = makeTarget(dir, target!, read);
  if (!found || found.recipe.some(rewrites)) return undefined;
  const scripts = found.prerequisites ? undefined : pythonOnlyRecipe(found, dir, read);
  const command = dir ? `make -C ${dir} ${target}` : `make ${target}`;
  return {
    id: command,
    script: workflowPath,
    runsScript: false,
    command,
    kind: makeKind(target!, found.recipe),
    decision: "RUN",
    reason: `run by CI workflow ${workflowPath}`,
    pythonOnly: scripts !== undefined,
    triggers: [found.path, ...(scripts ?? [])],
  };
}

function toolCheck(line: string, workflowPath: string): PythonCheck | undefined {
  const call = directToolCall(line);
  if (!call) return undefined;
  return { id: call.command, script: workflowPath, runsScript: false, command: call.command, kind: call.kind, decision: "RUN", reason: `run by CI workflow ${workflowPath}`, pythonOnly: true, triggers: [] };
}

function pythonRelevant(path: string): boolean {
  return PY_FILE.test(path) || PY_CONFIG.test(posix.basename(path)) || path.startsWith(".github/workflows/");
}

/** Skips Python-only checks for a change with no Python file, Python configuration or trigger in it. */
export function narrowPythonChecks(checks: readonly PythonCheck[], changes: readonly ChangedPath[]): PythonCheck[] {
  return checks.map((check) => {
    if (!check.pythonOnly) return { ...check, reason: `${check.reason}; not read as Python-only, runs as written` };
    const hit = changes.find((change) => pythonRelevant(change.path) || check.triggers.includes(change.path));
    return hit
      ? { ...check, reason: `${check.reason}; ${hit.path} changed` }
      : { ...check, decision: "SKIP", reason: `${check.reason}; no changed Python file or Python configuration` };
  });
}
