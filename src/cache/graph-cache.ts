// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DependencyGraphResult } from "../repo/types.js";

// 4: bounded computed loads have edges, and results carry runtimeTestSelection (2026-11-03).
// 5: inline type-only imports are type edges and vi.mock/jest.mock targets are edges (2026-11-04).
// 6: the profile's diffciConfig carries declared `inputs` (2026-11-05).
// 7: folded computed specifiers and root-absolute Vite globs have edges (2026-11-06).
// 8: Python projects have a graph, and the profile carries pythonSources/pythonTests (2026-11-06).
// 11: results carry export-level `bindings` (2026-11-10).
// 12: bindings mark computed loads that run when a module loads (2026-11-10).
// 13: tsd and tstyche scope type edges to their own files (typeTestGlobs) (2026-11-10).
export const GRAPH_CACHE_SCHEMA_VERSION = "13";

export interface GraphCacheKeyInputs {
  commitSha: string;
  tsconfigHash?: string;
  configHash?: string;
  diffciVersion?: string;
}

export interface CachedGraphResult extends DependencyGraphResult {
  cacheKey: string;
}

export function buildGraphCacheKey(inputs: GraphCacheKeyInputs): string {
  const payload = JSON.stringify({
    schema: GRAPH_CACHE_SCHEMA_VERSION,
    commit: inputs.commitSha,
    tsconfig: inputs.tsconfigHash ?? "",
    config: inputs.configHash ?? "",
    diffciVersion: inputs.diffciVersion ?? "0.6.0-phase6",
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function hashFileContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export class GraphCache {
  private readonly cacheDir: string;

  constructor(options: { cacheDir: string }) {
    this.cacheDir = resolve(options.cacheDir);
  }

  private ensureDir(): void {
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private cachePath(key: string): string {
    return resolve(this.cacheDir, `${key}.json`);
  }

  load(key: string): DependencyGraphResult | undefined {
    const path = this.cachePath(key);
    if (!existsSync(path)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }

    let parsed: (DependencyGraphResult & { cacheSchemaVersion?: string; cacheKey?: string }) | undefined;
    try {
      parsed = JSON.parse(raw) as DependencyGraphResult & { cacheSchemaVersion?: string; cacheKey?: string };
    } catch {
      return undefined;
    }

    if (!parsed || parsed.cacheSchemaVersion !== GRAPH_CACHE_SCHEMA_VERSION) return undefined;
    if (typeof parsed.cacheKey === "string" && parsed.cacheKey !== key) return undefined;
    return parsed;
  }

  save(key: string, result: DependencyGraphResult): void {
    this.ensureDir();
    const payload = JSON.stringify({ ...result, cacheSchemaVersion: GRAPH_CACHE_SCHEMA_VERSION }, null, 2);
    writeFileSync(this.cachePath(key), payload);
  }

  invalidate(key: string): void {
    const path = this.cachePath(key);
    if (existsSync(path)) {
      // Intentional no-op delete to avoid accidental loss; callers can remove manually.
      writeFileSync(path, JSON.stringify({ invalidated: true }));
    }
  }
}
