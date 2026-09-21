import { readdirSync } from "node:fs";
import { join } from "node:path";
import { goAdapter } from "./go.js";
import { vueAdapter } from "./vue.js";
import type { RepositoryAdapter } from "./types.js";

export const REPOSITORY_ADAPTERS: readonly RepositoryAdapter[] = [vueAdapter, goAdapter];

/** Never follows symlinks or scans dependency/build output directories. */
export function adapterFiles(root: string, exclusions: readonly string[] = []): string[] {
  const ignored = new Set([".git", "node_modules", "vendor", ".next", "dist", "build", "coverage", "tmp", "temp"]);
  const files: string[] = [];
  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) continue;
      if (entry.isDirectory() && !ignored.has(entry.name)) walk(join(dir, entry.name), path);
      else if (entry.isFile()) files.push(path);
    }
  }
  walk(root, "");
  return files.sort();
}
