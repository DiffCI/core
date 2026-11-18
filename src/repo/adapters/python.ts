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
 * and each file's basedir: its own directory when that has no `__init__.py`, otherwise the first
 * directory above its package (pytest's default `prepend` import mode puts the basedir on sys.path). Importing `a.b.c` also reaches `a/__init__.py` and `a/b/__init__.py`,
 * which run on import. Tests follow pytest's `python_files` and `testpaths`; each test also depends on
 * every `conftest.py` from its directory up to the root, which pytest loads before it, and on every
 * plugin module that `addopts` loads with `-p`.
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
const PROJECT_FILES = ["pyproject.toml", "setup.py", "setup.cfg", "pytest.toml", ".pytest.toml", "pytest.ini", ".pytest.ini", "tox.ini", "conftest.py"];

export function isPythonSource(path: string): boolean {
  return path.endsWith(".py") && !path.split("/").some((part) => EXCLUDED_DIRS.has(part) || part.endsWith(".egg-info"));
}

/** The interpreters `pythonInterpreter()` tries, in order: `python3`, `python`, then the Windows launcher `py -3`. */
export const PYTHON_INTERPRETER_CANDIDATES: readonly (readonly string[])[] = [["python3"], ["python"], ["py", "-3"]];

/**
 * The first of `PYTHON_INTERPRETER_CANDIDATES` that runs Python 3. Each call probes again, so two calls
 * can disagree when a launcher is slow or flaky (a Windows `python3` alias stub); use the interpreter
 * the analysis recorded (`profile.pythonInterpreter`) rather than a second probe (#304).
 */
export function pythonInterpreter(cwd: string): string[] | undefined {
  for (const entry of PYTHON_INTERPRETER_CANDIDATES) {
    const candidate = [...entry];
    const result = spawnSync(candidate[0]!, [...candidate.slice(1), "-c", "import sys; print(sys.version_info[0])"], { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.status === 0 && result.stdout.trim() === "3") return candidate;
  }
  return undefined;
}

export interface PytestSettings {
  pythonFiles: string[];
  testpaths: string[];
  pythonpath: string[];
  /** Plugin modules `addopts` loads with `-p`; every test depends on them. */
  plugins?: string[];
  /** A key that is present but could not be read; its file makes the analysis fall back. */
  unreadable?: string;
}

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((entry) => entry.replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * The strings of a TOML array of strings that starts with `[` at `start`. Comments, commas and line breaks
 * between the strings are skipped, and a `]`, `,` or `#` inside a quoted string stays part of the value.
 * Anything else (a nested array, a number, a multi-line string, an escape it cannot read, no closing `]`)
 * returns undefined, so the caller can fall back instead of guessing.
 */
function readTomlStringArray(text: string, start: number): string[] | undefined {
  const values: string[] = [];
  const escapes: Record<string, string> = { "\\": "\\", '"': '"', b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" };
  let index = start + 1;
  let expectValue = true;
  while (index < text.length) {
    const char = text[index]!;
    if (char === " " || char === "\t" || char === "\r" || char === "\n") index += 1;
    else if (char === "#") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (char === "]") return values;
    else if (char === ",") {
      if (expectValue) return undefined;
      expectValue = true;
      index += 1;
    } else if ((char === '"' || char === "'") && expectValue) {
      if (text.startsWith(char.repeat(3), index)) return undefined;
      let value = "";
      index += 1;
      for (;;) {
        const next = text[index];
        if (next === undefined || next === "\n") return undefined;
        if (next === char) break;
        if (next === "\\" && char === '"') {
          const escaped = escapes[text[index + 1] ?? ""];
          if (escaped === undefined) return undefined;
          value += escaped;
          index += 2;
        } else {
          value += next;
          index += 1;
        }
      }
      index += 1;
      values.push(value);
      expectValue = false;
    } else return undefined;
  }
  return undefined;
}

/** pytest's own configuration, from the first file pytest would use. Only the keys selection depends on. */
export function readPytestSettings(read: (path: string) => string | undefined): PytestSettings {
  const settings: PytestSettings = { pythonFiles: ["test_*.py", "*_test.py"], testpaths: [], pythonpath: [] };
  const keys = ["python_files", "testpaths", "pythonpath", "addopts"] as const;
  const apply = (key: (typeof keys)[number], values: string[]) => {
    if (key === "python_files") settings.pythonFiles = values;
    else if (key === "addopts") {
      // `-p name` and `-pname` import a plugin module before collection; `-p no:name` disables one.
      const plugins = values.flatMap((value, index) => value === "-p" ? [values[index + 1] ?? ""] : value.startsWith("-p") && !value.startsWith("--") ? [value.slice(2)] : [])
        .filter((name) => !name.startsWith("no:"));
      if (plugins.length) settings.plugins = plugins;
    } else settings[key] = values;
  };
  const section = (text: string, header: string): string | undefined =>
    new RegExp(`^\\[${header.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text)?.[1];
  const hasEntries = (body: string) => /^[ \t]*[^\s#]/m.test(body);
  // pytest 9's native TOML mode (`pytest.toml`, `[tool.pytest]`): every key selection reads is a list of
  // strings, and each `addopts` item is one argument. Any other type is an error in pytest, so it can't be read.
  const readNative = (file: string, body: string) => {
    for (const key of keys) {
      const array = new RegExp(`^${key}\\s*=\\s*(?=\\[)`, "m").exec(body);
      if (array) {
        const values = readTomlStringArray(body, array.index + array[0].length);
        if (values) apply(key, values);
        else settings.unreadable = `${file} ${key}`;
      } else if (new RegExp(`^${key}\\s*=`, "m").test(body)) settings.unreadable = `${file} ${key}`;
    }
    return settings;
  };
  // pytest's search order. `pytest.toml`, `.pytest.toml`, `pytest.ini` and `.pytest.ini` match even when
  // empty or without their `[pytest]` table, and then pytest uses its defaults; the other files only match
  // with their section. The first match wins and options are never merged.
  for (const [file, header] of [["pytest.toml", "pytest"], [".pytest.toml", "pytest"], ["pytest.ini", "pytest"], [".pytest.ini", "pytest"], ["pyproject.toml", "tool.pytest.ini_options"], ["tox.ini", "pytest"], ["setup.cfg", "tool:pytest"]] as const) {
    const text = read(file);
    if (text === undefined) continue;
    if (file === "pytest.toml" || file === ".pytest.toml") {
      const body = section(text, "pytest");
      if (body !== undefined) return readNative(file, body);
      // pytest rejects options written above any table.
      if (hasEntries(text.split(/^\[/m, 1)[0]!)) settings.unreadable = `${file} options outside [pytest]`;
      return settings;
    }
    if (file === "pyproject.toml") {
      // `[tool.pytest]` holds native TOML values, `[tool.pytest.ini_options]` INI-style ones. pytest refuses a
      // file that sets both, and an `ini_options` key inside `[tool.pytest]` is a form this reader doesn't parse.
      const native = section(text, "tool.pytest");
      const ini = section(text, header);
      if (native !== undefined && /^ini_options\s*[.=]/m.test(native)) { settings.unreadable = `${file} [tool.pytest] ini_options`; return settings; }
      if (native !== undefined && hasEntries(native)) {
        if (ini !== undefined && hasEntries(ini)) { settings.unreadable = `${file} [tool.pytest] and [tool.pytest.ini_options]`; return settings; }
        return readNative(file, native);
      }
    }
    const body = section(text, header);
    if (body === undefined) {
      if (file === "pytest.ini" || file === ".pytest.ini") return settings;
      continue;
    }
    for (const key of keys) {
      if (file === "pyproject.toml") {
        const match = new RegExp(`^${key}\\s*=\\s*("[^"]*"|'[^']*')`, "m").exec(body);
        const array = new RegExp(`^${key}\\s*=\\s*(?=\\[)`, "m").exec(body);
        // A multi-line string would otherwise match as an empty one. Its contents are read as one string;
        // a basic string's line-ending backslash only joins lines. An unterminated one cannot be read.
        const multiline = new RegExp(`^${key}\\s*=\\s*("""|'{3})([\\s\\S]*?)\\1`, "m").exec(body);
        if (multiline) apply(key, splitList(multiline[1] === '"""' ? multiline[2]!.replace(/\\\r?\n/g, " ") : multiline[2]!));
        else if (new RegExp(`^${key}\\s*=\\s*(?:"""|'{3})`, "m").test(body)) settings.unreadable = `${file} ${key}`;
        else if (array) {
          const values = readTomlStringArray(body, array.index + array[0].length);
          if (values) apply(key, key === "addopts" ? values.flatMap(splitList) : values);
          else settings.unreadable = `${file} ${key}`;
        } else if (match) apply(key, splitList(match[1]!));
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

/** One path segment against one shell-style glob segment, as Python's `fnmatch` reads it. */
function segmentMatches(glob: string, segment: string): boolean {
  const source = glob.replace(/\[!/g, "[^").replace(/[.+${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  try { return new RegExp(`^${source}$`).test(segment); } catch { return glob === segment; }
}

/** Whether `segments` starts with directories (or is a file) that `glob` names; `**` spans any depth. */
function globPrefixMatches(glob: readonly string[], segments: readonly string[]): boolean {
  if (!glob.length) return true;
  const [head, ...rest] = glob;
  if (head === "**") return segments.some((_, index) => globPrefixMatches(rest, segments.slice(index))) || globPrefixMatches(rest, []);
  return segments.length > 0 && segmentMatches(head!, segments[0]!) && globPrefixMatches(rest, segments.slice(1));
}

export function isPytestFile(path: string, settings: PytestSettings): boolean {
  const base = posix.basename(path);
  if (!settings.pythonFiles.some((glob) => globToRegExp(glob).test(base))) return false;
  if (!settings.testpaths.length) return true;
  return settings.testpaths.some((root) => {
    const clean = root.replace(/^\.\//, "").replace(/\/$/, "");
    if (clean === "." || clean === "") return true;
    // pytest expands each testpaths entry with glob.iglob(entry, recursive=True).
    if (/[*?[]/.test(clean)) return globPrefixMatches(clean.split("/"), path.split("/"));
    return path === clean || path.startsWith(`${clean}/`);
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
  // pytest's default `prepend` import mode puts the basedir on sys.path: the file's own directory when
  // it is not in a package, otherwise the first directory above its package (the nearest ancestor
  // without `__init__.py`). Undefined when the package reaches the repository root.
  const basedirOf = (dir: string): string | undefined => {
    let base = dir;
    while (isPackageDir(base)) {
      if (!base) return undefined;
      base = posix.dirname(base) === "." ? "" : posix.dirname(base);
    }
    return base;
  };
  for (const file of files) {
    const entry = parsed[file];
    if (!entry || entry.error) { blockers.push(`Python file could not be parsed (${entry?.error ?? "no result"}): ${file}`); continue; }
    if (entry.dynamic) blockers.push(`Python computed import in ${file}; full validation required`);
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    const basedir = basedirOf(dir);
    const fileRoots = basedir === undefined || roots.includes(basedir) ? roots : [...roots, basedir];
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
      // Plugins named by `-p` in addopts are imported before any test is collected.
      for (const plugin of settings.plugins ?? []) {
        const parts = plugin.split(".");
        const target = roots.map((root) => moduleFiles(root, parts)).find(Boolean);
        if (target) add(target);
        else if (!plugin || firstParty.has(parts[0]!)) {
          const blocker = `Unresolved pytest plugin in addopts: -p ${plugin}`;
          if (!blockers.includes(blocker)) blockers.push(blocker);
        }
      }
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
