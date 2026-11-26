import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** Absent, readable text, or an entry we could not verify. */
function readInput(path: string): string | null | undefined {
  let fd: number | undefined;
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) return undefined;
    if (!entry.isFile() || entry.size > 64 * 1024) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) return null;
    const bytes = Buffer.alloc(entry.size + 1);
    return readSync(fd, bytes, 0, bytes.length, 0) === entry.size ? bytes.subarray(0, entry.size).toString("utf8") : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function absent(path: string): boolean {
  try { return lstatSync(path, { throwIfNoEntry: false }) === undefined; } catch { return false; }
}

function pathIsUnambiguous(repoPath: string, env: NodeJS.ProcessEnv): boolean {
  const path = env.PATH ?? env.Path;
  if (path !== undefined && path.split(delimiter).some((dir) => !isAbsolute(dir))) return false;
  if (process.platform !== "win32") return true;
  // cmd.exe and Windows program lookup can search the current directory before PATH.
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
  return extensions.every((extension) => /^\.[a-z\d]+$/i.test(extension))
    && ["nox", "ruff", "mypy"].every((tool) => ["", ...extensions].every((ext) => absent(join(repoPath, tool + ext))));
}

function toxConfigIsLocal(repoPath: string, env: NodeJS.ProcessEnv): boolean {
  // tox 4 reads CLI defaults from its user config. tox 3 searches pyproject.toml
  // before tox.ini, including parent directories. A quoted TOML key may use escapes.
  const home = env.HOME || homedir();
  // On Windows, platformdirs looks up a known folder through the registry or
  // shell. LOCALAPPDATA alone does not establish the path used by Python.
  if (process.platform === "win32" || !isAbsolute(home) || (env.XDG_CONFIG_HOME && !isAbsolute(env.XDG_CONFIG_HOME))) return false;
  const configDirs = [join(home, ".config"), join(home, "Library/Application Support")];
  if (env.XDG_CONFIG_HOME) configDirs.push(env.XDG_CONFIG_HOME);
  if (configDirs.some((dir) => !absent(join(dir, "tox/config.ini")))) return false;
  let dir: string;
  try { dir = realpathSync(repoPath); } catch { return false; }
  for (; ; dir = dirname(dir)) {
    const source = readInput(join(dir, "pyproject.toml"));
    if (source === null || (source !== undefined && /legacy_tox_ini|\\/.test(source))) return false;
    if (dirname(dir) === dir) return true;
  }
}

/** Return a marker for an inline plugin, including an unreadable or dangling link.
 * Discovery only needs to know whether its absence can be established. */
export function readPythonSessionFile(repoPath: string, file: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (file === "toxfile.py" || file === "☣.py") return absent(join(repoPath, file)) ? undefined : "";
  const tox = file === "tox.ini";
  if (!tox && file !== "noxfile.py") return undefined;
  // These override the leaf check's write destination or its module search paths.
  if (["RUFF_OUTPUT_FILE", "RUFF_CACHE_DIR", "MYPY_CACHE_DIR", "MYPYPATH", "MYPY_TEST_PREFIX"].some((key) => env[key] !== undefined)) return undefined;
  if (Object.keys(env).some((key) => tox ? /^TOX/i.test(key) : /^NOX/i.test(key) && key.toUpperCase() !== "NOX_CURRENT_SESSION")) return undefined;
  const source = readInput(join(repoPath, file));
  if (!source || !pathIsUnambiguous(repoPath, env) || (tox && !toxConfigIsLocal(repoPath, env))) return undefined;
  return source;
}

export function isPythonSession(command: string): boolean {
  return /^(?:tox -e |nox -s )/.test(command);
}

/** A caller handing the bare Nox command to another process cannot isolate
 * its Python cache. Only hand it out when there is no cached noxfile to load. */
export function canHandOffNox(repoPath: string): boolean {
  if (process.env.PYTHONPYCACHEPREFIX || !absent(join(repoPath, "noxfile.pyc"))) return false;
  const cache = join(repoPath, "__pycache__");
  try {
    const entry = lstatSync(cache, { throwIfNoEntry: false });
    return !entry || (entry.isDirectory() && !readdirSync(cache).some((name) => /^noxfile\..*\.pyc$/i.test(name)));
  } catch { return false; }
}

/** Nox loads Python source through the interpreter's bytecode cache. Use the
 * source we just checked even if a previous checkout left a cached noxfile. */
export function withSessionEnvironment<T>(command: string, run: (env?: Record<string, string>) => T): T | undefined {
  if (!command.startsWith("nox -s ")) return run();
  let cache: string;
  try { cache = mkdtempSync(join(realpathSync(tmpdir()), "diffci-nox-cache-")); } catch { return undefined; }
  try { return run({ PYTHONPYCACHEPREFIX: cache, PYTHONDONTWRITEBYTECODE: "1" }); }
  finally { rmSync(cache, { recursive: true, force: true }); }
}
