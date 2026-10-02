// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { matchesGlob } from "./test-discovery.js";

/** Read declared workspace membership without executing manifests or following symlinks. */
export function declaredWorkspaceRoots(repoPath: string): string[] {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")); }
  catch { return []; }
  const declared = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  let patterns: unknown = declared;
  const pnpm = join(repoPath, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) patterns = parse(readFileSync(pnpm, "utf8"))?.packages;
  if (!Array.isArray(patterns) || patterns.some(p => typeof p !== "string" || p.startsWith("/") || p.includes("\\") || p.split("/").includes(".."))) return [];
  const candidates: string[] = [];
  const ignored = new Set(["node_modules", "dist", "build", "coverage", "tmp", "temp"]);
  function walk(root: string): void {
    for (const entry of readdirSync(join(repoPath, root), { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith(".")) continue;
      const path = root ? `${root}/${entry.name}` : entry.name;
      if (existsSync(join(repoPath, path, "package.json"))) candidates.push(path);
      walk(path);
    }
  }
  walk("");
  return candidates.filter(path => patterns.some(p => !p.startsWith("!") && matchesGlob(path, p)) && !patterns.some(p => p.startsWith("!") && matchesGlob(path, p.slice(1)))).sort();
}
