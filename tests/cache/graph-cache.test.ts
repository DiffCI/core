// SPDX-License-Identifier: AGPL-3.0-only
import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPH_CACHE_SCHEMA_VERSION, GraphCache, buildGraphCacheKey, hashFileContents } from "../../src/cache/graph-cache.js";
import type { DependencyGraphResult } from "../../src/repo/types.js";

const minimalGraph: DependencyGraphResult = {
  graph: {
    nodes: [],
    edges: [],
    forward: {},
    reverse: {},
    dependenciesOf: () => [],
    dependentsOf: () => [],
    transitiveDependenciesOf: () => [],
    transitiveDependentsOf: () => [],
  },
  profile: {} as DependencyGraphResult["profile"],
  unresolved: [],
  references: [],
  counts: { internalSource: 0, internalAsset: 0, externalPackage: 0, platformBuiltin: 0, unresolved: 0 },
  externalReferences: 0,
  platformBuiltinReferences: 0,
  internalAssetEdges: 0,
  performance: { durationMs: 0, filesDiscovered: 0, filesParsed: 0 },
  confidence: "COMPLETE",
  integrity: { findings: [], criticalCount: 0, warningCount: 0, stats: { nodeCount: 0, sourceNodeCount: 0, assetNodeCount: 0, edgeCount: 0, assetEdgeCount: 0 } },
  resolvedViaProjectReferences: false,
};

describe("GraphCache", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "diffci-cache-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("misses when no cached entry exists", () => {
    const cache = new GraphCache({ cacheDir });
    const key = buildGraphCacheKey({ commitSha: "abc" });
    assert.equal(cache.load(key), undefined);
  });

  it("hits after saving a graph result", () => {
    const cache = new GraphCache({ cacheDir });
    const key = buildGraphCacheKey({ commitSha: "abc" });
    cache.save(key, minimalGraph);
    const loaded = cache.load(key);
    assert.ok(loaded);
    assert.equal(loaded!.confidence, "COMPLETE");
  });

  it("invalidates a cached key", () => {
    const cache = new GraphCache({ cacheDir });
    const key = buildGraphCacheKey({ commitSha: "abc" });
    cache.save(key, minimalGraph);
    cache.invalidate(key);
    const loaded = cache.load(key);
    assert.equal(loaded, undefined);
  });

  it("treats keys with different config hashes as distinct", () => {
    const cache = new GraphCache({ cacheDir });
    const tsconfigHash = hashFileContents("a");
    const keyA = buildGraphCacheKey({ commitSha: "abc", tsconfigHash });
    const keyB = buildGraphCacheKey({ commitSha: "abc", tsconfigHash: hashFileContents("b") });
    cache.save(keyA, minimalGraph);
    assert.ok(cache.load(keyA));
    assert.equal(cache.load(keyB), undefined);
  });

  it("ignores stale schema versions", () => {
    const cache = new GraphCache({ cacheDir });
    const key = buildGraphCacheKey({ commitSha: "abc" });
    const stale = JSON.stringify({ ...minimalGraph, cacheSchemaVersion: "0" });
    writeFileSync(`${cacheDir}/${key}.json`, stale);
    assert.equal(cache.load(key), undefined);
  });

  it("rejects corrupted serialized graph cache", () => {
    const cache = new GraphCache({ cacheDir });
    const key = buildGraphCacheKey({ commitSha: "abc" });
    writeFileSync(`${cacheDir}/${key}.json`, "{ not valid json");
    assert.equal(cache.load(key), undefined);
  });

  it("rejects a cache written for a different cache key", () => {
    const cache = new GraphCache({ cacheDir });
    const key = buildGraphCacheKey({ commitSha: "abc" });
    const otherKey = buildGraphCacheKey({ commitSha: "def" });
    const mismatch = JSON.stringify({ ...minimalGraph, cacheSchemaVersion: GRAPH_CACHE_SCHEMA_VERSION, cacheKey: otherKey });
    writeFileSync(`${cacheDir}/${key}.json`, mismatch);
    assert.equal(cache.load(key), undefined);
  });
});
