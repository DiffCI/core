/**
 * Opt-in shared dependency-graph cache, client side (2026-10-31). See docs/shared-graph-cache.md.
 *
 * A read-through/write-back layer around the local graph cache (core's src/cache/graph-cache.ts):
 *
 *   load:  local disk -> DiffCI Cloud -> (miss: the caller builds the graph as it always has)
 *   save:  local disk now, remote PUT in the background, awaited by `flush()` with a timeout
 *
 * Three rules, enforced here rather than promised:
 *
 *   - OFF UNLESS ASKED. Nothing is constructed unless the caller opted in AND gave an endpoint and a
 *     token. The observer's default behaviour - nothing leaves the runner - is unchanged.
 *   - A FAILURE IS A MISS. Every remote problem (network, timeout, 4xx/5xx, entitlement, integrity,
 *     decryption, an envelope for another key, a shape we do not recognise) degrades to "not cached".
 *     Nothing here throws to the caller, and a miss only means the graph is built locally - the analysis
 *     result is identical either way.
 *   - THE GRAPH, NEVER THE SOURCE. The payload is the derived DependencyGraphResult: repository-relative
 *     file paths, import edges, unresolved import specifiers, and repository profile metadata (package.json
 *     script strings and dependency names, tsconfig path aliases, test globs). No file contents. Absolute
 *     checkout paths are replaced with a placeholder before anything is written, so neither the runner's
 *     directory layout nor a username leaves the machine, and a graph built in /home/runner/work/x is valid
 *     in C:\src\x. With DIFFCI_GRAPH_CACHE_SECRET set, the payload is AES-256-GCM encrypted client-side and
 *     the remote key is an HMAC under the same secret: DiffCI stores bytes it cannot read or correlate.
 *
 * Path hashing (like --redact-paths) was considered and rejected: a graph whose paths are digests cannot
 * be matched against the next change's paths without a reverse map, and a lossy round trip is exactly
 * what must never change a selection. Encryption gives the same privacy with a lossless round trip.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { DependencyGraphResult } from "@diffci.com/core/repo/types";
import type { GitRunner } from "./context.js";

export const SHARED_GRAPH_CACHE_ENVELOPE_SCHEMA = "diffci.graph-cache.v1";
export const CONTENT_SHA256_HEADER = "x-diffci-content-sha256";
/** Bumped whenever the portable payload format or the key inputs below change. */
export const SHARED_GRAPH_CACHE_KEY_SCHEMA = "shared-1";
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const REPO_TOKEN = "\u0000diffci:repo\u0000";
const REPO_POSIX_TOKEN = "\u0000diffci:repo-posix\u0000";
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
const CONFIG_FILES = ["tsconfig.json", "package.json", "diffci.config.json", "jsconfig.json"];

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function readHash(path: string): string {
  try { return existsSync(path) ? sha256(readFileSync(path)) : "absent"; } catch { return "unreadable"; }
}

/**
 * The cache key for the graph of `repoPath` as it is checked out right now, or undefined when no key
 * can honestly describe it. A dirty working tree has no commit that names it, so it is never cached.
 *
 * Inputs: HEAD, the schema of this format, DiffCI's version and engine commit, hashes of the files that
 * steer resolution (tsconfig/package/DiffCI config, lockfiles), whether node_modules is installed, the
 * platform, and the excluded directories. The output is a SHA-256 digest; the commit is not readable from it.
 */
export function deriveSharedGraphCacheKey(input: {
  repoPath: string;
  git: GitRunner;
  version: string;
  engineSha?: string;
  excludeDirs: readonly string[];
  platform?: string;
}): string | undefined {
  try {
    const head = input.git(["rev-parse", "HEAD"]);
    const status = input.git(["status", "--porcelain", "--untracked-files=all"]);
    if (!head.ok || !status.ok) return undefined;
    const commitSha = head.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commitSha) || status.stdout.trim() !== "") return undefined;
    const repoPath = resolve(input.repoPath);
    const payload = JSON.stringify({
      schema: SHARED_GRAPH_CACHE_KEY_SCHEMA,
      commit: commitSha,
      diffci: `${input.version}:${input.engineSha ?? ""}`,
      config: Object.fromEntries(CONFIG_FILES.map((file) => [file, readHash(join(repoPath, file))])),
      lockfiles: Object.fromEntries(LOCKFILES.map((file) => [file, readHash(join(repoPath, file))])),
      nodeModules: existsSync(join(repoPath, "node_modules")),
      platform: input.platform ?? process.platform,
      exclude: [...input.excludeDirs].sort(),
    });
    return sha256(payload);
  } catch {
    return undefined;
  }
}

/** True for graphs that must not be shared: Go metadata depends on the local toolchain. */
function isUncacheable(result: DependencyGraphResult): boolean {
  return result.profile?.adapters?.some((adapter) => adapter.id === "go") === true || result.graph.nodes.length === 0;
}

function mapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[transform(key)] = mapStrings(item, transform);
    return out;
  }
  return value;
}

/** Plain, machine-independent JSON: the graph reduced to nodes and edges, the checkout path tokenised. */
export function toPortableGraph(result: DependencyGraphResult, repoPath: string): Record<string, unknown> {
  const native = resolve(repoPath);
  const posix = native.replace(/\\/g, "/");
  const projected = { ...result, graph: { nodes: result.graph.nodes, edges: result.graph.edges } };
  const plain = JSON.parse(JSON.stringify(projected)) as unknown;
  return mapStrings(plain, (text) => {
    if (text === native || text.startsWith(native + "/") || text.startsWith(native + "\\")) return REPO_TOKEN + text.slice(native.length);
    if (posix !== native && (text === posix || text.startsWith(posix + "/"))) return REPO_POSIX_TOKEN + text.slice(posix.length);
    return text;
  }) as Record<string, unknown>;
}

/** The inverse of toPortableGraph, against this machine's checkout. Undefined for an unrecognised shape. */
export function fromPortableGraph(portable: unknown, repoPath: string): DependencyGraphResult | undefined {
  const native = resolve(repoPath);
  const posix = native.replace(/\\/g, "/");
  const restored = mapStrings(portable, (text) =>
    text.startsWith(REPO_TOKEN) ? native + text.slice(REPO_TOKEN.length)
      : text.startsWith(REPO_POSIX_TOKEN) ? posix + text.slice(REPO_POSIX_TOKEN.length)
        : text) as Partial<DependencyGraphResult> | undefined;
  if (!restored || typeof restored !== "object") return undefined;
  const graph = restored.graph as { nodes?: unknown; edges?: unknown } | undefined;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !restored.profile || typeof restored.profile !== "object") return undefined;
  return restored as DependencyGraphResult;
}

function encryptionKey(secret: string): Buffer {
  return createHash("sha256").update(`diffci-graph-cache-v1:${secret}`).digest();
}

/** With a team secret, the server sees an HMAC of the key, not the key. Different secrets never collide. */
export function remoteCacheKey(localKey: string, secret?: string): string {
  return secret ? createHmac("sha256", encryptionKey(secret)).update(localKey).digest("hex") : localKey;
}

export function encodeEnvelope(remoteKey: string, portable: Record<string, unknown>, options: { secret?: string; version?: string } = {}): string {
  const producer = { diffci: options.version ?? "unknown" };
  if (!options.secret) {
    return JSON.stringify({ schema: SHARED_GRAPH_CACHE_ENVELOPE_SCHEMA, key: remoteKey, encoding: "json", producer, payload: portable });
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(options.secret), iv);
  cipher.setAAD(Buffer.from(remoteKey));
  const data = Buffer.concat([cipher.update(JSON.stringify(portable), "utf8"), cipher.final()]);
  return JSON.stringify({
    schema: SHARED_GRAPH_CACHE_ENVELOPE_SCHEMA, key: remoteKey, encoding: "aes-256-gcm", producer,
    payload: { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") },
  });
}

/** Undefined for anything that is not exactly an envelope for `remoteKey` that we can read. */
export function decodeEnvelope(remoteKey: string, body: string, secret?: string): unknown {
  try {
    const envelope = JSON.parse(body) as { schema?: unknown; key?: unknown; encoding?: unknown; payload?: unknown };
    if (envelope.schema !== SHARED_GRAPH_CACHE_ENVELOPE_SCHEMA || envelope.key !== remoteKey) return undefined;
    if (envelope.encoding === "json") return secret ? undefined : envelope.payload;
    if (envelope.encoding !== "aes-256-gcm" || !secret) return undefined;
    const payload = envelope.payload as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(payload.iv, "base64"));
    decipher.setAAD(Buffer.from(remoteKey));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as unknown;
  } catch {
    return undefined;
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/**
 * Where the cache lives, from an explicit URL or the configured ingest URL's origin. Undefined (cache
 * off) for anything unparseable or plaintext to a non-loopback host - a token is never sent over http.
 */
export function resolveSharedGraphCacheBaseUrl(input: { cacheUrl?: string; apiUrl?: string }): string | undefined {
  try {
    if (input.cacheUrl) {
      const url = new URL(input.cacheUrl);
      if (url.protocol !== "https:" && !isLoopback(url)) return undefined;
      return url.toString().replace(/\/+$/, "");
    }
    if (!input.apiUrl) return undefined;
    const url = new URL(input.apiUrl);
    if (url.protocol !== "https:" && !isLoopback(url)) return undefined;
    return `${url.origin}/v1/cache/graph`;
  } catch {
    return undefined;
  }
}

export interface RemoteGraphCacheOptions {
  baseUrl: string;
  token: string;
  secret?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The DiffCI Cloud tier. Every method resolves; none throws. */
export class RemoteGraphCache {
  constructor(private readonly options: RemoteGraphCacheOptions) {}

  private async request(method: "GET" | "PUT", remoteKey: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? (method === "GET" ? 5_000 : 15_000));
    try {
      return await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}/${remoteKey}`, {
        method,
        body: init.body,
        headers: { authorization: `Bearer ${this.options.token}`, ...init.headers },
        signal: controller.signal,
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Portable payload for `localKey`, or undefined on any miss or failure. */
  async get(localKey: string): Promise<unknown> {
    const remoteKey = remoteCacheKey(localKey, this.options.secret);
    const response = await this.request("GET", remoteKey);
    if (!response || response.status !== 200) return undefined;
    try {
      const body = await response.text();
      if (body.length > MAX_ENTRY_BYTES) return undefined;
      // End-to-end integrity: what arrived must be what the server says it stored.
      const declared = response.headers.get(CONTENT_SHA256_HEADER);
      if (!declared || declared.toLowerCase() !== sha256(body)) return undefined;
      return decodeEnvelope(remoteKey, body, this.options.secret);
    } catch {
      return undefined;
    }
  }

  async put(localKey: string, portable: Record<string, unknown>): Promise<boolean> {
    try {
      const remoteKey = remoteCacheKey(localKey, this.options.secret);
      const body = encodeEnvelope(remoteKey, portable, { secret: this.options.secret, version: this.options.version });
      if (Buffer.byteLength(body, "utf8") > MAX_ENTRY_BYTES) return false;
      const response = await this.request("PUT", remoteKey, {
        body,
        headers: { "content-type": "application/json", [CONTENT_SHA256_HEADER]: sha256(body) },
      });
      return response !== undefined && (response.status === 200 || response.status === 201);
    } catch {
      return false;
    }
  }
}

/** Structural match for GraphCache (src/cache/graph-cache.ts here, or Core's), so either can sit underneath. */
export interface LocalGraphCacheLike {
  load(key: string): DependencyGraphResult | undefined;
  save(key: string, result: DependencyGraphResult): void;
}

export type GraphCacheSource = "local" | "remote";

export class LayeredGraphCache {
  private readonly pending: Promise<unknown>[] = [];
  /** What the last load did, for a one-line summary. */
  lastOutcome: "local-hit" | "remote-hit" | "miss" | undefined;

  constructor(private readonly options: { repoPath: string; local?: LocalGraphCacheLike; remote?: RemoteGraphCache }) {}

  async load(key: string): Promise<{ result: DependencyGraphResult; source: GraphCacheSource } | undefined> {
    const { repoPath, local, remote } = this.options;
    try {
      const fromDisk = local?.load(key);
      const restored = fromDisk ? fromPortableGraph(fromDisk, repoPath) : undefined;
      if (restored && !isUncacheable(restored)) {
        this.lastOutcome = "local-hit";
        return { result: restored, source: "local" };
      }
    } catch { /* unreadable local entry: fall through */ }
    if (remote) {
      const portable = await remote.get(key);
      const restored = portable === undefined ? undefined : fromPortableGraph(portable, repoPath);
      if (restored && !isUncacheable(restored)) {
        // Read-through: the next run on this machine does not need the network.
        try { local?.save(key, portable as DependencyGraphResult); } catch { /* local is an optimisation */ }
        this.lastOutcome = "remote-hit";
        return { result: restored, source: "remote" };
      }
    }
    this.lastOutcome = "miss";
    return undefined;
  }

  /** Synchronous to the caller; the remote write runs in the background until flush(). */
  save(key: string, result: DependencyGraphResult): void {
    try {
      if (isUncacheable(result)) return;
      const portable = toPortableGraph(result, this.options.repoPath);
      try { this.options.local?.save(key, portable as unknown as DependencyGraphResult); } catch { /* ignore */ }
      if (this.options.remote) this.pending.push(this.options.remote.put(key, portable).catch(() => false));
    } catch { /* never fail the analysis */ }
  }

  /** Waits for background uploads, bounded by their own request timeouts. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending.splice(0));
  }
}

export interface GraphCacheConfigInput {
  repoPath: string;
  version: string;
  /** --graph-cache-dir / DIFFCI_GRAPH_CACHE_DIR: local tier only, no network. */
  localDir?: string;
  /** --shared-graph-cache / DIFFCI_SHARED_GRAPH_CACHE=1: also use DiffCI Cloud. */
  shared?: boolean;
  /** --graph-cache-url / DIFFCI_GRAPH_CACHE_URL, else derived from the ingest URL's origin. */
  cacheUrl?: string;
  apiUrl?: string;
  token?: string;
  /** DIFFCI_GRAPH_CACHE_SECRET only - never a flag, so it cannot land in shell history or `ps`. */
  secret?: string;
  noSend?: boolean;
  redactPaths?: boolean;
  /** Where a shared cache keeps its local tier when no directory is given. */
  defaultLocalRoot: string;
  local?: (dir: string) => LocalGraphCacheLike;
  fetchImpl?: typeof fetch;
  isInsideRepository: (repoPath: string, candidate: string) => boolean;
}

/**
 * The opt-in decision, in one place. No `cache` means no caching at all - the observer's default. Notes say
 * why a requested tier was left off, without ever repeating the token or secret.
 */
export function configureGraphCache(input: GraphCacheConfigInput): { cache?: LayeredGraphCache; notes: string[] } {
  const notes: string[] = [];
  let localDir = input.localDir ?? (input.shared ? join(input.defaultLocalRoot, "diffci-graph-cache") : undefined);
  if (localDir && input.isInsideRepository(input.repoPath, localDir)) {
    notes.push("local graph cache disabled: the directory is inside the checkout");
    localDir = undefined;
  }
  let remote: RemoteGraphCache | undefined;
  if (input.shared) {
    const baseUrl = resolveSharedGraphCacheBaseUrl({ cacheUrl: input.cacheUrl, apiUrl: input.apiUrl });
    const secret = input.secret && input.secret.length >= 16 ? input.secret : undefined;
    if (input.secret && !secret) notes.push("DIFFCI_GRAPH_CACHE_SECRET ignored: it must be at least 16 characters");
    if (input.noSend) notes.push("shared graph cache off: --no-send");
    else if (!baseUrl) notes.push("shared graph cache off: no https api-url or graph-cache-url");
    else if (!input.token) notes.push("shared graph cache off: no api-token");
    else if (input.redactPaths && !secret) notes.push("shared graph cache off: --redact-paths needs DIFFCI_GRAPH_CACHE_SECRET, because the graph carries file paths");
    else remote = new RemoteGraphCache({ baseUrl, token: input.token, secret, version: input.version, fetchImpl: input.fetchImpl });
  }
  if (!localDir && !remote) return { cache: undefined, notes };
  const local = localDir && input.local ? input.local(localDir) : undefined;
  return { cache: new LayeredGraphCache({ repoPath: input.repoPath, local, remote }), notes };
}
