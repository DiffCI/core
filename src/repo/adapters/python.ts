// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { contribution, type AdapterContext, type AdapterContribution, type RepositoryAdapter } from "./types.js";

/**
 * Python repositories tested with pytest (2026-11-06).
 *
 * WHY. The ML-pipelines expansion and most outside design-partner candidates run Python; until now a
 * Python change was an unknown file and every run was the full suite.
 *
 * WHAT. The import graph comes from Python's own `ast` module, run once over every `.py` file (a short
 * script on stdin; no repository code is imported or executed, unlike `pytest --collect-only`, which runs
 * conftest.py). DiffCI resolves each import against the repository root, `src/`, pytest's `pythonpath`
 * and, for a file in a directory without `__init__.py`, that directory (pytest's default `prepend`
 * import mode puts it on sys.path). Importing `a.b.c` also reaches `a/__init__.py` and `a/b/__init__.py`,
 * which run on import. Tests follow pytest's `python_files` and `testpaths`; each test also depends on
 * every `conftest.py` from its directory up to the root, which pytest loads before it.
 *
 * Full validation instead, as global blockers: no Python interpreter, a file that does not parse, an
 * `importlib.import_module` / `__import__` / `pytest_plugins` entry whose name is computed, a first-party
 * module that cannot be resolved, and pytest configuration this reader cannot follow. Ruff's or Tach's
 * import maps could replace the `ast` script later; neither is needed for correctness.
 */

const PARSE_SCRIPT = String.raw`
import ast, json, sys
out = {}
for path in json.load(sys.stdin):
    try:
        with open(path, "rb") as handle:
            tree = ast.parse(handle.read(), filename=path)
    except Exception as error:
        out[path] = {"error": type(error).__name__}
        continue
    imports, dynamic = [], False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend([alias.name, 0, []] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.append([node.module or "", node.level, [alias.name for alias in node.names]])
        elif isinstance(node, ast.Call):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
            if name in ("import_module", "__import__"):
                first = node.args[0] if node.args else None
                if isinstance(first, ast.Constant) and isinstance(first.value, str) and not first.value.startswith("."):
                    imports.append([first.value, 0, []])
                else:
                    dynamic = True
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "pytest_plugins" for t in node.targets):
            values = node.value.elts if isinstance(node.value, (ast.List, ast.Tuple)) else [node.value]
            for value in values:
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    imports.append([value.value, 0, []])
                else:
                    dynamic = True
    out[path] = {"imports": imports, "dynamic": dynamic}
json.dump(out, sys.stdout)
`;

export type PythonImport = [module: string, level: number, names: string[]];
export interface PythonFileImports { imports?: PythonImport[]; dynamic?: boolean; error?: string }

const EXCLUDED_DIRS = new Set([".venv", "venv", "env", ".env", ".tox", ".nox", "site-packages", "__pycache__", ".eggs", ".mypy_cache", ".pytest_cache", ".ruff_cache"]);
const PROJECT_FILES = ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "conftest.py"];

export function isPythonSource(path: string): boolean {
  return path.endsWith(".py") && !path.split("/").some((part) => EXCLUDED_DIRS.has(part) || part.endsWith(".egg-info"));
}

/** The first interpreter that runs: `python3`, `python`, then the Windows launcher `py -3`. */
export function pythonInterpreter(cwd: string): string[] | undefined {
  for (const candidate of [["python3"], ["python"], ["py", "-3"]]) {
    const result = spawnSync(candidate[0]!, [...candidate.slice(1), "-c", "import sys; print(sys.version_info[0])"], { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.status === 0 && result.stdout.trim() === "3") return candidate;
  }
  return undefined;
}

export interface PytestSettings {
  pythonFiles: string[];
  testpaths: string[];
  pythonpath: string[];
  /** A key that is present but could not be read; its file makes the analysis fall back. */
  unreadable?: string;
}

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((entry) => entry.replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** pytest's own configuration, from the first file pytest would use. Only the keys selection depends on. */
export function readPytestSettings(read: (path: string) => string | undefined): PytestSettings {
  const settings: PytestSettings = { pythonFiles: ["test_*.py", "*_test.py"], testpaths: [], pythonpath: [] };
  const keys = ["python_files", "testpaths", "pythonpath"] as const;
  const apply = (key: (typeof keys)[number], values: string[]) => {
    if (key === "python_files") settings.pythonFiles = values;
    else settings[key] = values;
  };
  for (const [file, header] of [["pytest.ini", "pytest"], ["pyproject.toml", "tool.pytest.ini_options"], ["tox.ini", "pytest"], ["setup.cfg", "tool:pytest"]] as const) {
    const text = read(file);
    if (text === undefined) continue;
    const section = new RegExp(`^\\[${header.replace(/[.:]/g, "\\$&")}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text);
    if (!section) continue;
    const body = section[1]!;
    for (const key of keys) {
      if (file === "pyproject.toml") {
        const match = new RegExp(`^${key}\\s*=\\s*(\\[[\\s\\S]*?\\]|"[^"]*"|'[^']*')`, "m").exec(body);
        if (match) apply(key, splitList(match[1]!.replace(/^\[|\]$/g, "")));
        else if (new RegExp(`^${key}\\s*=`, "m").test(body)) settings.unreadable = `${file} ${key}`;
      } else {
        // INI values continue on indented lines.
        const match = new RegExp(`^${key}\\s*=\\s*(.*(?:\\r?\\n[ \\t]+.*)*)`, "m").exec(body);
        if (match) apply(key, splitList(match[1]!));
      }
    }
    return settings;
  }
  return settings;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
}

export function isPytestFile(path: string, settings: PytestSettings): boolean {
  const base = posix.basename(path);
  if (!settings.pythonFiles.some((glob) => globToRegExp(glob).test(base))) return false;
  if (!settings.testpaths.length) return true;
  return settings.testpaths.some((root) => {
    const clean = root.replace(/^\.\//, "").replace(/\/$/, "");
    return clean === "." || clean === "" || path === clean || path.startsWith(`${clean}/`);
  });
}

/**
 * Turns the `ast` imports into repository edges. Pure, so it is tested without an interpreter.
 */
export function resolvePythonGraph(files: readonly string[], parsed: Record<string, PythonFileImports>, settings: PytestSettings, tests: ReadonlySet<string>): { edges: Array<{ from: string; to: string }>; blockers: string[] } {
  const known = new Set(files);
  const edges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  const edge = (from: string, to: string) => {
    const key = `${from}\n${to}`;
    if (from === to || seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };
  const blockers: string[] = [];
  const roots = [...new Set(["", "src", ...settings.pythonpath.map((path) => path.replace(/^\.\//, "").replace(/\/$/, "").replace(/^\.$/, ""))])];
  const firstParty = new Set<string>();
  for (const file of files) {
    for (const root of roots) {
      const prefix = root ? `${root}/` : "";
      if (!file.startsWith(prefix)) continue;
      const top = file.slice(prefix.length).split("/")[0]!;
      firstParty.add(top.replace(/\.py$/, ""));
    }
  }
  const moduleFiles = (base: string, parts: string[]): string[] | undefined => {
    const dir = [base, ...parts].filter(Boolean).join("/");
    const candidate = [`${dir}.py`, `${dir}/__init__.py`].find((path) => known.has(path));
    if (!candidate) return undefined;
    // Parent packages run their __init__.py on import.
    const inits: string[] = [];
    for (let depth = 1; depth < parts.length; depth += 1) {
      const init = [base, ...parts.slice(0, depth), "__init__.py"].filter(Boolean).join("/");
      if (known.has(init)) inits.push(init);
    }
    return [candidate, ...inits];
  };
  const isPackageDir = (dir: string) => known.has(dir ? `${dir}/__init__.py` : "__init__.py");
  for (const file of files) {
    const entry = parsed[file];
    if (!entry || entry.error) { blockers.push(`Python file could not be parsed (${entry?.error ?? "no result"}): ${file}`); continue; }
    if (entry.dynamic) blockers.push(`Python computed import in ${file}; full validation required`);
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    const fileRoots = isPackageDir(dir) ? roots : [...roots, dir];
    const add = (targets: string[] | undefined) => { for (const to of targets ?? []) edge(file, to); };
    for (const [module, level, names] of entry.imports ?? []) {
      if (level > 0) {
        let base = dir;
        for (let up = 1; up < level; up += 1) base = posix.dirname(base) === "." ? "" : posix.dirname(base);
        const parts = module ? module.split(".") : [];
        const target = parts.length ? moduleFiles(base, parts) : [base ? `${base}/__init__.py` : "__init__.py"].filter((path) => known.has(path));
        const submodules = names.map((name) => moduleFiles(base, [...parts, name])).filter((found): found is string[] => Boolean(found));
        // `from . import x` in a namespace package has no __init__.py, only the submodule.
        if (!target?.length && !submodules.length) { blockers.push(`Unresolved relative import in ${file}: ${".".repeat(level)}${module}`); continue; }
        add(target);
        for (const found of submodules) add(found);
        continue;
      }
      const parts = module.split(".");
      const target = fileRoots.map((root) => moduleFiles(root, parts)).find(Boolean);
      if (!target) {
        if (firstParty.has(parts[0]!) && parts.length > 1) blockers.push(`Unresolved first-party Python import in ${file}: ${module}`);
        continue;
      }
      add(target);
      for (const name of names) add(fileRoots.map((root) => moduleFiles(root, [...parts, name])).find(Boolean));
    }
    // pytest loads every conftest.py from the rootdir down to the test's directory first.
    if (tests.has(file)) {
      const segments = dir ? dir.split("/") : [];
      for (let depth = 0; depth <= segments.length; depth += 1) {
        const conftest = [...segments.slice(0, depth), "conftest.py"].join("/");
        if (known.has(conftest)) edge(file, conftest);
      }
    }
  }
  return { edges, blockers };
}

export function analyzePythonRepository(context: AdapterContext, parse: (files: string[]) => Record<string, PythonFileImports> | string): AdapterContribution {
  const result = contribution(pythonAdapter);
  const read = (path: string) => { const full = join(context.repoPath, path); return existsSync(full) ? readFileSync(full, "utf8") : undefined; };
  const settings = readPytestSettings(read);
  if (settings.unreadable) { result.blockers.push(`pytest configuration DiffCI cannot read: ${settings.unreadable}`); return result; }
  const files = context.files.filter(isPythonSource);
  const parsed = parse(files);
  if (typeof parsed === "string") { result.blockers.push(parsed); return result; }
  const tests = new Set(files.filter((file) => isPytestFile(file, settings)));
  const graph = resolvePythonGraph(files, parsed, settings, tests);
  result.sourcePaths.push(...files);
  result.testFiles.push(...tests);
  for (const test of tests) result.testPackages[test] = ".";
  result.edges.push(...graph.edges.map((edge) => ({ ...edge, kind: "import" as const })));
  result.blockers.push(...graph.blockers);
  if (!files.length) result.blockers.push("Python analysis found no Python files");
  return result;
}

export const pythonAdapter: RepositoryAdapter = {
  id: "python", version: "1", kind: "language",
  detect: ({ files }) => PROJECT_FILES.some((file) => files.includes(file)) && files.some(isPythonSource),
  analyze(context) {
    const interpreter = pythonInterpreter(context.repoPath);
    const result = analyzePythonRepository(context, (files) => {
      if (!interpreter) return "Python analysis needs a Python 3 interpreter (python3, python or py -3) on PATH";
      const run = spawnSync(interpreter[0]!, [...interpreter.slice(1), "-c", PARSE_SCRIPT], {
        cwd: context.repoPath, input: JSON.stringify(files), encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
      });
      if (run.status !== 0) return `Python import analysis failed: ${(run.stderr || run.error?.message || "").trim().split(/\r?\n/).pop() ?? "unknown error"}`;
      try { return JSON.parse(run.stdout) as Record<string, PythonFileImports>; }
      catch { return "Python import analysis produced unreadable output"; }
    });
    if (interpreter) result.interpreter = interpreter;
    return result;
  },
};
