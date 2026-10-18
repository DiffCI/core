import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DiffciPackageIdentity {
  version: string;
  root?: string;
  sha?: string;
}

function checkoutSha(packageRoot: string): string | undefined {
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const normalizedPackageRoot = resolve(packageRoot);
    const normalizedGitRoot = resolve(gitRoot);
    const rootsMatch = process.platform === "win32"
      ? normalizedPackageRoot.toLowerCase() === normalizedGitRoot.toLowerCase()
      : normalizedPackageRoot === normalizedGitRoot;
    if (!rootsMatch) return undefined;
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Installed tarballs intentionally have no checkout SHA.
    return undefined;
  }
}

/**
 * Find package metadata without assuming whether this code is running from
 * source, a build directory, or an installed npm tarball.
 */
export function findDiffciPackageIdentity(): DiffciPackageIdentity | undefined {
  let current = dirname(import.meta.filename);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (parsed.name === "@diffci/observer") {
          return { version: parsed.version ?? "0.0.0", root: current };
        }
        if (parsed.name === "@diffci.com/diffci" || parsed.name === "diffci") {
          return { version: parsed.version ?? "0.0.0", root: current, sha: checkoutSha(current) };
        }
      } catch {
        // An unreadable ancestor says nothing about this package; keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** Preserve the CLI's historical unknown-version fallback for diagnostics. */
export function observerIdentity(): DiffciPackageIdentity {
  return findDiffciPackageIdentity() ?? { version: "0.0.0" };
}

/** MCP negotiation must never advertise an invented release version. */
export function requireDiffciPackageIdentity(): DiffciPackageIdentity {
  const identity = findDiffciPackageIdentity();
  if (!identity) {
    throw new Error("DiffCI MCP must run from an installed @diffci.com/diffci package.");
  }
  return identity;
}
