import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";

/**
 * Repository-local runners launched without Windows `.cmd` shims (2026-11-09).
 *
 * WHY. Selected TypeScript tests run as `npx --no-install tsx --test <files>`. On Windows `npx` is
 * `npx.cmd`, which hands its arguments to node in a second cmd.exe line, and npx then starts `tsx.cmd`,
 * a third. Each line adds the node and shim paths, and npm escapes arguments with `^`, and cmd.exe
 * rejects any line over 8,191 characters. A DentalPresence selection of 282 files, batched into parts
 * of at most 8,000 characters, still failed before any test ran with exit 255 and "The syntax of the
 * command is incorrect"; `node node_modules/tsx/dist/cli.mjs` with the same files ran all 1,260 tests.
 *
 * WHAT. On Windows a command starting `npx --no-install <bin>` runs as `node <script>` when the
 * package's bin is a JavaScript file reached through the repository's node_modules, with
 * node_modules/.bin on PATH as npx would put it. Anything else (a native binary, a bin that cannot be
 * resolved, other platforms) runs unchanged.
 */

const NPX_PREFIX = /^npx --no-install ([\w@./-]+)(?=\s|$)/;
const SAFE_PATH = /^[\w./@+-]+$/;

/** The `.bin` directory npx would use for `bin`: the nearest one at or above `cwd` that has it. */
function binDirectory(cwd: string, bin: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ".bin");
    if (existsSync(join(candidate, bin)) || existsSync(join(candidate, `${bin}.cmd`))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The JavaScript file the npm/pnpm `sh` shim for `bin` runs with node, or undefined. */
function shimScript(binDir: string, bin: string): string | undefined {
  const shim = join(binDir, bin);
  if (!existsSync(shim)) return undefined;
  let text: string;
  try { text = readFileSync(shim, "utf8"); } catch { return undefined; }
  // npm: exec node  "$basedir/../tsx/dist/cli.mjs" "$@"   pnpm: exec node  "$basedir/../tsx/dist/cli.mjs" "$@"
  const match = /exec\s+(?:"\$basedir\/node"|node)\s+"\$basedir\/([^"$]+)"\s+"\$@"/.exec(text);
  if (!match) return undefined;
  const script = resolve(binDir, match[1]!);
  return /\.(?:c|m)?js$/.test(script) && existsSync(script) ? script : undefined;
}

/**
 * `command` as Windows should launch it from `cwd`: `npx --no-install <bin> ...` becomes
 * `node <script> ...` with the extra PATH entry, or `command` unchanged when that is not safe.
 */
export function windowsLaunch(command: string, cwd: string): { command: string; pathEntry?: string } {
  const match = NPX_PREFIX.exec(command);
  if (!match) return { command };
  const binDir = binDirectory(cwd, match[1]!);
  const script = binDir ? shimScript(binDir, match[1]!) : undefined;
  if (!binDir || !script) return { command };
  const path = relative(cwd, script).replace(/\\/g, "/");
  if (!SAFE_PATH.test(path)) return { command };
  return { command: `node ${path}${command.slice(match[0].length)}`, pathEntry: binDir };
}

/** `env` with `entry` first on PATH, keeping Windows' own spelling of the key (usually `Path`). */
export function withPathEntry(env: NodeJS.ProcessEnv, entry: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key];
  return { ...env, [key]: current ? `${entry}${delimiter}${current}` : entry };
}
