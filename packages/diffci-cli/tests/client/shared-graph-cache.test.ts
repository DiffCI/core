/**
 * Shared graph cache, client side (2026-10-31): key derivation, lossless portable round trip, integrity,
 * encryption, opt-in gating, and - the property everything else rests on - that every remote failure is
 * a miss and a cache hit produces the same observation as a cold build.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { GraphCache } from "@diffci.com/core/cache/graph-cache";
import { isInsideRepository, makeGitRunner, observe } from "../../src/client/observe.js";
import {
  CONTENT_SHA256_HEADER,
  LayeredGraphCache,
  RemoteGraphCache,
  configureGraphCache,
  decodeEnvelope,
  deriveSharedGraphCacheKey,
  encodeEnvelope,
  fromPortableGraph,
  remoteCacheKey,
  toPortableGraph,
} from "../../src/client/shared-graph-cache.js";
import type { DependencyGraphResult } from "@diffci.com/core/repo/types";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const KEY = "a".repeat(64);

function git(repoPath: string, command: string): string {
  return execSync(`git ${command}`, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(repoPath: string, relativePath: string, contents: string): void {
  const absolute = join(repoPath, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-sgc-"));
  git(dir, "init --quiet");
  git(dir, "config user.email test@diffci.local");
  git(dir, "config user.name Test");
  git(dir, "config core.autocrlf false");
  write(dir, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", devDependencies: { vitest: "^1.0.0" }, scripts: { test: "vitest run" } }, null, 2));
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src", "test"] }, null, 2));
  write(dir, "src/alpha.ts", "export const alpha = () => 1;\n");
  write(dir, "src/beta.ts", "export const beta = () => 2;\n");
  write(dir, "test/alpha.test.ts", "import { alpha } from '../src/alpha.js';\nexport const check = () => alpha();\n");
  write(dir, "test/beta.test.ts", "import { beta } from '../src/beta.js';\nexport const check = () => beta();\n");
  git(dir, "add -A");
  git(dir, 'commit --quiet -m "initial"');
  return dir;
}

function graphFixture(repoPath: string): DependencyGraphResult {
  return {
    graph: {
      nodes: [{ path: "src/a.ts", isSource: true, isAsset: false, isTest: false, isEntryPoint: false }],
      edges: [{ from: "test/a.test.ts", to: "src/a.ts", kind: "import" }],
      forward: {}, reverse: {},
      dependenciesOf: () => [], dependentsOf: () => [], transitiveDependenciesOf: () => [], transitiveDependentsOf: () => [],
    },
    profile: { tsconfig: { path: join(resolve(repoPath), "tsconfig.json"), pathAliases: [], allowJs: false, include: [], exclude: [] }, testFilePaths: ["test/a.test.ts"] } as unknown as DependencyGraphResult["profile"],
    unresolved: [],
    references: [],
    counts: { internalSource: 1, internalAsset: 0, externalPackage: 0, platformBuiltin: 0, unresolved: 0 },
    externalReferences: 0,
    platformBuiltinReferences: 0,
    internalAssetEdges: 0,
    performance: { durationMs: 5, filesDiscovered: 1, filesParsed: 1 },
    confidence: "COMPLETE",
    integrity: { findings: [], criticalCount: 0, warningCount: 0, stats: { nodeCount: 1, sourceNodeCount: 1, assetNodeCount: 0, edgeCount: 1, assetEdgeCount: 0 } },
    resolvedViaProjectReferences: false,
  } as DependencyGraphResult;
}

/** A Map-backed fake of the hosted endpoint, faithful to its integrity header. */
function fakeServer() {
  const objects = new Map<string, string>();
  const calls: Array<{ method: string; url: string; auth?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method!, url, auth: headers.authorization });
    const key = url.split("/").pop()!;
    if (init.method === "PUT") {
      const body = init.body as string;
      if (headers[CONTENT_SHA256_HEADER] !== sha256(body)) return new Response("{}", { status: 400 });
      objects.set(key, body);
      return new Response("{}", { status: 201 });
    }
    const body = objects.get(key);
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(body, { status: 200, headers: { [CONTENT_SHA256_HEADER]: sha256(body) } });
  }) as unknown as typeof fetch;
  return { objects, calls, fetchImpl };
}

describe("shared graph cache key derivation", () => {
  let repo: string;
  beforeEach(() => { repo = fixtureRepo(); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  const derive = (overrides: Partial<Parameters<typeof deriveSharedGraphCacheKey>[0]> = {}) =>
    deriveSharedGraphCacheKey({ repoPath: repo, git: makeGitRunner(repo), version: "1.0.0", engineSha: "e", excludeDirs: ["node_modules"], platform: "linux", ...overrides });

  it("is a deterministic SHA-256 that does not expose the commit", () => {
    const key = derive();
    assert.match(key ?? "", /^[0-9a-f]{64}$/);
    assert.equal(derive(), key);
    assert.equal(key!.includes(git(repo, "rev-parse HEAD").trim()), false);
  });

  it("changes with DiffCI version, engine, platform, and excluded directories", () => {
    const base = derive();
    assert.notEqual(derive({ version: "1.0.1" }), base);
    assert.notEqual(derive({ engineSha: "f" }), base);
    assert.notEqual(derive({ platform: "win32" }), base);
    assert.notEqual(derive({ excludeDirs: ["node_modules", "dist"] }), base);
  });

  it("changes with the commit and with the configuration that steers resolution", () => {
    const base = derive();
    write(repo, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: false } }));
    git(repo, "commit --quiet -am config");
    const afterConfig = derive();
    assert.ok(afterConfig && afterConfig !== base);
    mkdirSync(join(repo, "node_modules"));
    // node_modules is gitignored-or-untracked here; an untracked empty dir does not show in porcelain.
    assert.notEqual(derive(), afterConfig, "installing dependencies changes resolution, so it changes the key");
  });

  it("refuses to name a dirty working tree", () => {
    write(repo, "src/alpha.ts", "export const alpha = () => 3;\n");
    assert.equal(derive(), undefined);
    git(repo, "checkout -- src/alpha.ts");
    write(repo, "src/new.ts", "export {};\n");
    assert.equal(derive(), undefined, "untracked files are part of the graph too");
  });

  it("returns undefined rather than throwing when git fails", () => {
    assert.equal(deriveSharedGraphCacheKey({ repoPath: repo, git: () => ({ ok: false, error: "x" }), version: "1", excludeDirs: [] }), undefined);
    assert.equal(deriveSharedGraphCacheKey({ repoPath: repo, git: () => { throw new Error("boom"); }, version: "1", excludeDirs: [] }), undefined);
  });
});

describe("portable payload and envelope", () => {
  it("removes the absolute checkout path and restores it on another machine", () => {
    const origin = join(tmpdir(), "runner", "work", "repo");
    const portable = toPortableGraph(graphFixture(origin), origin);
    const serialized = JSON.stringify(portable);
    assert.equal(serialized.includes(resolve(origin).replace(/\\/g, "\\\\")), false);
    assert.equal(serialized.includes("dependenciesOf"), false, "only nodes and edges of the graph are carried");
    const elsewhere = join(tmpdir(), "laptop", "repo");
    const restored = fromPortableGraph(JSON.parse(serialized), elsewhere)!;
    assert.equal((restored.profile as unknown as { tsconfig: { path: string } }).tsconfig.path, join(resolve(elsewhere), "tsconfig.json"));
    assert.deepEqual(restored.graph.edges, graphFixture(origin).graph.edges);
  });

  it("rejects payloads that are not a graph", () => {
    assert.equal(fromPortableGraph({ graph: {} }, "/x"), undefined);
    assert.equal(fromPortableGraph("nope", "/x"), undefined);
  });

  it("round-trips encrypted envelopes and refuses the wrong secret, a plaintext substitute, or another key", () => {
    const secret = "team-secret-0123456789";
    const remoteKey = remoteCacheKey(KEY, secret);
    assert.notEqual(remoteKey, KEY);
    const body = encodeEnvelope(remoteKey, { hello: "world" }, { secret });
    assert.equal(body.includes("world"), false, "ciphertext only");
    assert.deepEqual(decodeEnvelope(remoteKey, body, secret), { hello: "world" });
    assert.equal(decodeEnvelope(remoteKey, body, "another-secret-0123"), undefined);
    assert.equal(decodeEnvelope(remoteKey, encodeEnvelope(remoteKey, { forged: true }), secret), undefined, "an unauthenticated plaintext entry is not trusted when a secret is configured");
    assert.equal(decodeEnvelope("b".repeat(64), body, secret), undefined);
  });
});

describe("RemoteGraphCache and LayeredGraphCache", () => {
  const repoPath = join(tmpdir(), "layered-repo");

  it("writes back after a build and serves teammates read-through from the remote tier", async () => {
    const server = fakeServer();
    const remote = new RemoteGraphCache({ baseUrl: "https://api.example.test/v1/cache/graph", token: "dci_test_token", fetchImpl: server.fetchImpl });
    const writer = new LayeredGraphCache({ repoPath, remote });
    writer.save(KEY, graphFixture(repoPath));
    await writer.flush();
    assert.equal(server.objects.size, 1);
    assert.equal(server.calls[0]!.auth, "Bearer dci_test_token");

    const localDir = mkdtempSync(join(tmpdir(), "diffci-sgc-local-"));
    try {
      const reader = new LayeredGraphCache({ repoPath, local: new GraphCache({ cacheDir: localDir }), remote });
      const hit = await reader.load(KEY);
      assert.equal(hit?.source, "remote");
      assert.deepEqual(hit!.result.graph.nodes, graphFixture(repoPath).graph.nodes);
      const callsBefore = server.calls.length;
      assert.equal((await reader.load(KEY))?.source, "local", "the remote hit was written through to disk");
      assert.equal(server.calls.length, callsBefore);
    } finally { rmSync(localDir, { recursive: true, force: true }); }
  });

  it("treats a body that does not match its declared digest as a miss", async () => {
    const server = fakeServer();
    const remote = new RemoteGraphCache({ baseUrl: "https://x.test/c", token: "dci_t", fetchImpl: server.fetchImpl });
    const cache = new LayeredGraphCache({ repoPath, remote });
    cache.save(KEY, graphFixture(repoPath));
    await cache.flush();
    const tampering = (async () => new Response(server.objects.get(KEY)!.replace("src/a.ts", "src/b.ts"), { status: 200, headers: { [CONTENT_SHA256_HEADER]: sha256(server.objects.get(KEY)!) } })) as unknown as typeof fetch;
    assert.equal(await new RemoteGraphCache({ baseUrl: "https://x.test/c", token: "dci_t", fetchImpl: tampering }).get(KEY), undefined);
    const noHeader = (async () => new Response(server.objects.get(KEY)!, { status: 200 })) as unknown as typeof fetch;
    assert.equal(await new RemoteGraphCache({ baseUrl: "https://x.test/c", token: "dci_t", fetchImpl: noHeader }).get(KEY), undefined);
  });

  it("degrades silently on every kind of remote failure", async () => {
    const failures: Array<typeof fetch> = [
      (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
      (async () => new Response("{}", { status: 402 })) as unknown as typeof fetch,
      (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
      (async () => new Response("not json", { status: 200, headers: { [CONTENT_SHA256_HEADER]: sha256("not json") } })) as unknown as typeof fetch,
      ((_url: string, init: RequestInit) => new Promise((_, rejectFn) => init.signal!.addEventListener("abort", () => rejectFn(new Error("aborted"))))) as unknown as typeof fetch,
    ];
    for (const fetchImpl of failures) {
      const remote = new RemoteGraphCache({ baseUrl: "https://x.test/c", token: "dci_t", fetchImpl, timeoutMs: 20 });
      const cache = new LayeredGraphCache({ repoPath, remote });
      assert.equal(await cache.load(KEY), undefined);
      assert.equal(cache.lastOutcome, "miss");
      cache.save(KEY, graphFixture(repoPath));
      await cache.flush();
    }
  });

  it("never shares a Go graph or an empty graph", async () => {
    const server = fakeServer();
    const cache = new LayeredGraphCache({ repoPath, remote: new RemoteGraphCache({ baseUrl: "https://x.test/c", token: "dci_t", fetchImpl: server.fetchImpl }) });
    const go = graphFixture(repoPath);
    (go.profile as { adapters?: unknown }).adapters = [{ id: "go", version: "1", blockers: [] }];
    cache.save(KEY, go);
    const empty = graphFixture(repoPath);
    empty.graph.nodes = [];
    cache.save(KEY, empty);
    await cache.flush();
    assert.equal(server.objects.size, 0);
  });
});

describe("opt-in configuration", () => {
  const repoPath = join(tmpdir(), "cfg-repo");
  const base = { repoPath, version: "1", defaultLocalRoot: tmpdir(), isInsideRepository, local: (dir: string) => new GraphCache({ cacheDir: dir }) };

  it("is off unless asked, even with an api-url and token configured for report submission", () => {
    assert.equal(configureGraphCache({ ...base, apiUrl: "https://api.diffci.com/v1/ingest/observations", token: "dci_x" }).cache, undefined);
  });

  it("enables the remote tier only with opt-in, an https endpoint, and a token", () => {
    const on = configureGraphCache({ ...base, shared: true, apiUrl: "https://api.diffci.com/v1/ingest/observations", token: "dci_x" });
    assert.ok(on.cache);
    assert.deepEqual(on.notes, []);
    for (const [input, note] of [
      [{ apiUrl: "http://api.diffci.com/v1/ingest/observations", token: "dci_x" }, /https/],
      [{ apiUrl: "https://api.diffci.com/v1/ingest/observations" }, /api-token/],
      [{ apiUrl: "https://api.diffci.com/v1/ingest/observations", token: "dci_x", noSend: true }, /no-send/],
      [{ apiUrl: "https://api.diffci.com/v1/ingest/observations", token: "dci_x", redactPaths: true }, /redact-paths/],
    ] as const) {
      const result = configureGraphCache({ ...base, shared: true, ...input });
      assert.match(result.notes.join("\n"), note);
      assert.equal(result.notes.join("\n").includes("dci_x"), false, "the token is never echoed");
    }
    assert.deepEqual(configureGraphCache({ ...base, shared: true, apiUrl: "https://api.diffci.com/x", token: "dci_x", redactPaths: true, secret: "s".repeat(32) }).notes, []);
  });

  it("refuses a local directory inside the checkout", () => {
    const result = configureGraphCache({ ...base, localDir: join(repoPath, ".cache") });
    assert.equal(result.cache, undefined);
    assert.match(result.notes[0]!, /inside the checkout/);
  });
});

describe("observe with a graph cache", () => {
  let repo: string;
  beforeEach(() => { repo = fixtureRepo(); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("produces the same result cold, warm from the remote tier, and with a failing cache", async () => {
    const baseSha = git(repo, "rev-parse HEAD").trim();
    write(repo, "src/alpha.ts", "export const alpha = () => 10;\n");
    git(repo, "commit --quiet -am change");
    const headSha = git(repo, "rev-parse HEAD").trim();
    const run = (graphCache?: Parameters<typeof observe>[0]["graphCache"]) =>
      observe({ repoPath: repo, env: {}, version: "test", baseOverride: baseSha, headOverride: headSha, graphCache });

    const plain = await run();
    assert.equal(plain.status, "OBSERVED");

    const server = fakeServer();
    const remote = () => new RemoteGraphCache({ baseUrl: "https://x.test/c", token: "dci_t", fetchImpl: server.fetchImpl });
    const writer = new LayeredGraphCache({ repoPath: repo, remote: remote() });
    const cold = await run(writer);
    await writer.flush();
    assert.equal(writer.lastOutcome, "miss");
    assert.equal(server.objects.size, 1, "the built graph was written back");
    assert.equal([...server.objects.values()][0]!.includes("export const alpha"), false, "no source contents in the payload");

    const reader = new LayeredGraphCache({ repoPath: repo, remote: remote() });
    const warm = await run(reader);
    assert.equal(reader.lastOutcome, "remote-hit");

    const broken = await run({ load: async () => { throw new Error("down"); }, save: () => { throw new Error("down"); } });

    const strip = (report: typeof plain) => ({ ...report.result, graph: { ...report.result!.graph, durationMs: 0, phasesMs: undefined, typescriptProgram: undefined, adapterMetrics: undefined } });
    for (const report of [cold, warm, broken]) {
      assert.equal(report.status, "OBSERVED");
      assert.deepEqual(strip(report), strip(plain));
      assert.equal(report.nonInterference.worktreeUnchanged, true);
    }
    assert.deepEqual(warm.result!.selectedTests, ["test/alpha.test.ts"]);
  });
});
