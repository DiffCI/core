// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DependencyGraphResult } from "../repo/types.js";

export const GRAPH_CACHE_SCHEMA_VERSION = "1";

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
