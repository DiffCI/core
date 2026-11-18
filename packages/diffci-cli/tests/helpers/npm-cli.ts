import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The npm-cli.js that `npm` on PATH runs. `npm root -g` names the configured global prefix, which is not
 * where npm itself lives once a user prefix is set (`npm config set prefix ~/.local`, a common setup that
 * avoids sudo); the npm on PATH is a link to its own bin/npm-cli.js, so follow that link first.
 */
export function npmCliPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const npm = execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8", env }).split(/\r?\n/).find(Boolean)!;
    return join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  }
  const npm = execFileSync("which", ["npm"], { encoding: "utf8", env }).trim();
  const real = realpathSync(npm);
  if (/[\\/]npm-cli\.js$/.test(real)) return real;
  return join(execFileSync(npm, ["root", "-g"], { encoding: "utf8", env }).trim(), "npm", "bin", "npm-cli.js");
}
