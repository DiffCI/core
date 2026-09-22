import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRepositoryConfig } from "../repo/repo-config.js";

/** Files that determine whether a cached Vue analysis still matches the checkout configuration. */
export function economicsContext(repoPath: string): string {
  const scope = readRepositoryConfig(repoPath).vue;
  const paths = new Set(["diffci.json", "package.json", "tsconfig.json", "go.mod", "go.sum", "go.work", "go.work.sum", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", ...["ts", "js", "mts", "mjs", "cts", "cjs"].map(ext => `vitest.config.${ext}`)]);
  if (scope) for (const path of ["package.json", "tsconfig.json", scope.testConfig]) paths.add(`${scope.packageRoot}/${path}`);
  const hash = createHash("sha256").update(JSON.stringify([process.platform, process.arch, process.version]));
  for (const path of [...paths].sort()) {
    hash.update(JSON.stringify(path));
    const file = join(repoPath, path);
    hash.update(existsSync(file) ? readFileSync(file) : "<absent>");
    hash.update("\0");
  }
  return hash.digest("hex");
}
