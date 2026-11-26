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
 *     whose every argument is a plain word and none rewrites files or writes output. Before `uv run`,
 *     --directory and --project take repository-relative paths; --offline and --no-progress take no value;
 *   - a root-level `tox -e lint,type` or `nox -s lint types` selecting literal environments or sessions.
 *     Read the configuration as text. Keep the original runner command only if every selected command
 *     is a supported read-only check. Unknown options, setup, hooks or execution contexts add nothing.
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
import { noxCheckCommands } from "./nox-sessions.js";
import type { GateCheck } from "./pipeline-steps.js";
import { toxCheckCommands } from "./tox-environments.js";

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
const PY_CONFIG = /^(?:pyproject\.toml|setup\.cfg|setup\.py|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|pyrefly\.toml|ruff\.toml|\.ruff\.toml|tox\.ini|uv\.toml|uv\.lock|poetry\.lock|pdm\.lock|Pipfile|Pipfile\.lock|\.python-version|py\.typed|(?:requirements|constraints)[\w.-]*\.(?:txt|in))$/;
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
    return typeof dir === "string" ? dir : undefined;
  }
  return ".";
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

/** Strip only recognized pre-run globals for matching. Keep the original command for execution so
 * uv applies --directory and --project itself, in the order specified by the workflow. */
function withoutUvGlobals(command: string): string | undefined {
  if (!command.startsWith("uv --")) return command;
  const words = command.split(" ");
  const seen = new Set<string>();
  let i = 1;
  while (i < words.length) {
    const word = words[i++]!;
    if (word === "run") return ["uv", "run", ...words.slice(i)].join(" ");
    const equals = word.indexOf("=");
    const option = equals < 0 ? word : word.slice(0, equals);
    if (seen.has(option)) return undefined;
    seen.add(option);
    if (word === "--offline" || word === "--no-progress") continue;
    if (option !== "--directory" && option !== "--project") return undefined;
    const path = equals < 0 ? words[i++] : word.slice(equals + 1);
    if (!path || !/^[\w.][\w./-]*$/.test(path) || normalizeDir(path) === undefined) return undefined;
  }
  return undefined;
}

/** A direct Python tool call, normalized, with its kind; undefined when the line is anything else. */
export function directToolCall(line: string): { command: string; kind: GateCheck["kind"] } | undefined {
  const command = line.trim().replace(/\s+/g, " ");
  const invocation = withoutUvGlobals(command);
  if (!invocation) return undefined;
  const rest = invocation.replace(RUNNER_PREFIX, "");
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

/** Repository scripts read by a Python-only recipe, or undefined when a line cannot be classified. */
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
    const call = directToolCall(line.replace(/\s+\$\([\w]+\)/g, ""));
    if (call) {
      // A Make expansion could supply an additional uv option or the command after run.
      if (call.command.startsWith("uv --") && line.includes("$(")) return undefined;
      usesPython = true;
      continue;
    }
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

// These workflow forms select named declarations in order. A bare runner selects defaults and
// additional arguments can select different sessions, override configuration or invoke another tool.
const NAMED_ENV = /^[a-z][a-z0-9_-]*$/;
const PYTHON_TARGET = /^(?:\.|(?:\.\/)?(?:[\w][\w-]*\/)*[\w][\w-]*(?:\.(?:py|pyi|ipynb))?)$/;

// Ruff's fix and fix-only settings are independent. Mypy configuration can load plugins
// and request output files. Require the workflow's own arguments to rule out those effects.
const SESSION_TOOLS = [
  { prefix: "ruff check ", required: ["--no-fix", "--no-fix-only"], ruff: true },
  { prefix: "ruff format ", required: ["--check"], ruff: true },
  { prefix: "mypy ", required: ["--config-file="], ruff: false },
];

function sessionCheck(line: string, workflowPath: string, read: (path: string) => string | undefined): PythonCheck | undefined {
  const command = line.replace(/[ \t]+/g, " ");
  const tox = command.startsWith("tox -e ");
  if (!tox && !command.startsWith("nox -s ")) return undefined;
  const names = command.slice(7).split(tox ? "," : " ");
  if (names.some((name) => !NAMED_ENV.test(name)) || new Set(names).size !== names.length) return undefined;
  const config = tox ? "tox.ini" : "noxfile.py";
  const source = read(config);
  if (!source || source.length > 64 * 1024) return undefined;
  if (tox && (read("toxfile.py") !== undefined || read("☣.py") !== undefined)) return undefined;
  const commands = tox ? toxCheckCommands(source, names) : noxCheckCommands(source, names);
  if (!commands?.length) return undefined;
  const kinds = new Set<GateCheck["kind"]>();
  const triggers = new Set([config]);
  let pythonOnly = true;
  for (const leaf of commands) {
    const call = directToolCall(leaf);
    if (!call) return undefined;
    const tool = SESSION_TOOLS.find(({ prefix }) => call.command.startsWith(prefix));
    if (!tool) return undefined;
    const args = call.command.slice(tool.prefix.length).split(" ");
    if (!tool.required.every((flag) => args.includes(flag))) return undefined;
    // Ruff configuration may select extra file extensions or extend another arbitrary config.
    // Its check-only forms are still safe to run there, but only an isolated call can narrow.
    if (tool.ruff && !args.includes("--isolated")) pythonOnly = false;
    const paths = args.filter((word) => !tool.required.includes(word) && !(tool.ruff && word === "--isolated"));
    if ((!tool.ruff && !paths.length) || !paths.every((path) => PYTHON_TARGET.test(path))) return undefined;
    for (const path of paths) triggers.add(posix.normalize(path));
    kinds.add(call.kind);
  }
  const kind = kinds.size === 1 ? [...kinds][0]! : "script";
  return { id: command, command, kind, script: workflowPath, runsScript: false, pythonOnly,
    triggers: [...triggers], decision: "RUN", reason: `run by CI workflow ${workflowPath}` };
}

type ReadText = (path: string) => string | undefined;

/** Discover checks in workflow order. The CLI supplies a separate reader for session configuration
 * so its file and environment checks do not change how Makefiles and their scripts are read. */
export function discoverPythonChecks(workflows: readonly WorkflowFile[], read: ReadText, readSession: ReadText = read): PythonCheck[] {
  const checks: PythonCheck[] = [];
  const seen = new Set<string>();
  for (const workflow of workflows) {
    let doc: { jobs?: unknown; env?: unknown; defaults?: { run?: { shell?: unknown } } } | null;
    try { doc = parse(workflow.text) as typeof doc; } catch { continue; }
    if (!doc?.jobs || typeof doc.jobs !== "object") continue;
    for (const job of Object.values(doc.jobs as Record<string, unknown>)) {
      if (!job || typeof job !== "object") continue;
      const { steps, if: condition, defaults } = job as { steps?: unknown; if?: unknown; defaults?: { run?: { shell?: unknown } } };
      if (disabled(condition) || !Array.isArray(steps)) continue;
      const plainSessionJob = condition === undefined && doc.env === undefined && !("env" in job)
        && !("container" in job) && !("services" in job) && !("strategy" in job) && !("continue-on-error" in job)
        && defaults?.run?.shell === undefined && doc.defaults?.run?.shell === undefined;
      let unknownSessionContext = false;
      for (const step of steps) {
        const { run, if: stepCondition, env, shell, uses, with: inputs, "continue-on-error": optional } = (step ?? {}) as {
          run?: unknown; if?: unknown; env?: unknown; shell?: unknown; uses?: unknown; with?: unknown; "continue-on-error"?: unknown;
        };
        if (disabled(stepCondition)) continue;
        // An action can change the checkout, runner defaults or environment for later steps.
        if (uses !== undefined && !(typeof uses === "string" && /^actions\/checkout@(?:v\d+|[a-f0-9]{40})$/.test(uses)
          && inputs === undefined && env === undefined && stepCondition === undefined && optional === undefined)) unknownSessionContext = true;
        if (typeof run !== "string") continue;
        const canReadSession = !unknownSessionContext && plainSessionJob && stepCondition === undefined
          && uses === undefined && env === undefined && shell === undefined && optional === undefined;
        // A preceding script could have generated configuration or updated the runner environment.
        // Only a session whose complete command list we can read preserves this context.
        unknownSessionContext = true;
        const rawDir = workingDirectory(step, defaults?.run, doc.defaults?.run);
        const dir = rawDir === undefined ? undefined : normalizeDir(rawDir);
        if (dir === undefined) continue;
        const block = run.replace(/\r\n/g, "\n");
        const lines = block.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
        if (lines.some((line) => CONTEXT_CHANGE.test(line) || line.includes("${{"))) continue;
        for (const line of lines) {
          let check = makeCheck(line, dir, workflow.path, read) ?? (dir === "" ? toolCheck(line, workflow.path) : undefined);
          if (!check && canReadSession && /^(?:tox|nox)\s/.test(line) && (rawDir === "." || rawDir === "./")
            && lines.length === 1 && !block.includes("${{") && !/[^\t\n\x20-\x7e]/.test(block)) {
            check = sessionCheck(line, workflow.path, readSession);
            if (check) unknownSessionContext = false;
          }
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
  return {
    id: call.command, script: workflowPath, runsScript: false, command: call.command, kind: call.kind,
    decision: "RUN", reason: `run by CI workflow ${workflowPath}`, pythonOnly: true, triggers: [],
  };
}

function pythonRelevant(path: string): boolean {
  return PY_FILE.test(path) || PY_CONFIG.test(posix.basename(path)) || path.startsWith(".github/workflows/");
}

/** Skip unrelated changes. A session can read the target of a Python symlink under another
 * extension, so it can skip only when the caller has ruled out links in both Git trees. */
export function narrowPythonChecks(checks: readonly PythonCheck[], changes: readonly ChangedPath[], sessionInputsAreRegular?: () => boolean): PythonCheck[] {
  return checks.map((check) => {
    if (!check.pythonOnly) return { ...check, reason: `${check.reason}; not read as Python-only, runs as written` };
    // Even isolated Ruff consults nested ignore files when selecting inputs from a directory.
    const session = /^(?:tox -e |nox -s )/.test(check.command);
    const hit = changes.find(({ path }) => pythonRelevant(path) || check.triggers.includes(path)
      || (session && /(?:^|\/)\.(?:gitignore|ignore)$/.test(path)));
    if (hit) return { ...check, reason: `${check.reason}; ${hit.path} changed` };
    if (session && !sessionInputsAreRegular?.()) return { ...check, decision: "RUN", reason: `${check.reason}; cannot rule out symlinked Python inputs` };
    return { ...check, decision: "SKIP", reason: `${check.reason}; no changed Python file or Python configuration` };
  });
}
