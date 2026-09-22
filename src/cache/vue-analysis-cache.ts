import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { economicsContext } from "./economics-context.js";
import { vueAdapter } from "../repo/adapters/vue.js";
import { contribution, type AdapterContext, type AdapterContribution } from "../repo/adapters/types.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function physical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return resolve(physical(dirname(path)), relative(dirname(path), path));
}
function fingerprint(path: string): string {
  if (!existsSync(path)) return "absent";
  return JSON.stringify([realpathSync(path), statSync(path).isFile() ? digest(readFileSync(path)) : "directory"]);
}

/** Trusted runner-local cache, optional and never a source of test-selection authority.
 * Every hit validates source, context and all compiler filesystem probes. Graph resolution
 * and selection are rebuilt. Any unreadable/corrupt cache is an ordinary analysis miss. */
export function analyzeVueCached(context: AdapterContext, directory: string, version: string): AdapterContribution {
  let cacheDir: string;
  let namespace: string;
  try {
    cacheDir = physical(resolve(directory));
    const rel = relative(realpathSync(context.repoPath), cacheDir);
    if (!rel || (!(rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) && !isAbsolute(rel))) return vueAdapter.analyze(context);
    namespace = digest(JSON.stringify(["vue-analysis-v1", version, vueAdapter.version, realpathSync(context.repoPath), economicsContext(context.repoPath), context.files]));
  } catch { return vueAdapter.analyze(context); }
  const result = contribution(vueAdapter);
  const phasesMs: Record<string, number> = {};
  const counts: Record<string, number> = { cacheHits: 0, cacheMisses: 0, cacheWriteFailures: 0 };
  result.performance = { phasesMs, counts };
  for (const path of context.files.filter(file => file.endsWith(".vue"))) {
    const started = performance.now();
    const file = join(cacheDir, `${digest(path)}.json`);
    let key = "";
    let item: AdapterContribution | undefined;
    try {
      key = digest(JSON.stringify([namespace, path, fingerprint(join(context.repoPath, path))]));
      const envelope = JSON.parse(readFileSync(file, "utf8"));
      if (envelope.key === key && typeof envelope.payload === "string" && digest(envelope.payload) === envelope.sha256) {
        const data = JSON.parse(envelope.payload);
        if (Array.isArray(data.probes) && data.probes.every((probe: [string, string]) => Array.isArray(probe) && probe.length === 2 && typeof probe[0] === "string" && fingerprint(probe[0]) === probe[1])) item = data.result;
      }
    } catch { /* unreadable or stale entry: rebuild */ }
    phasesMs.cacheReadValidate = (phasesMs.cacheReadValidate ?? 0) + performance.now() - started;
    if (item) counts.cacheHits++;
    else {
      counts.cacheMisses++;
      const probes = new Map<string, string>();
      let cacheable = true;
      item = vueAdapter.analyze({ ...context, vueComponentPaths: [path], recordVueRead(file) {
        // TS config expansion can read extended configs through its own system host.
        // Until every such input is recorded, rebuild compiler-assisted components.
        if (file.endsWith(".json")) cacheable = false;
        try { probes.set(resolve(file), fingerprint(file)); } catch { cacheable = false; }
      } });
      if (key && cacheable) {
        const writeStart = performance.now();
        try {
          const { performance: _performance, ...cachedResult } = item;
          const payload = JSON.stringify({ probes: [...probes], result: cachedResult });
          mkdirSync(cacheDir, { recursive: true });
          const temporary = `${file}.${randomUUID()}.tmp`;
          writeFileSync(temporary, JSON.stringify({ key, payload, sha256: digest(payload) }));
          renameSync(temporary, file);
        } catch { counts.cacheWriteFailures++; }
        phasesMs.cacheWrite = (phasesMs.cacheWrite ?? 0) + performance.now() - writeStart;
      }
    }
    for (const field of ["sourcePaths", "assetPaths", "edges", "virtualSources", "testFiles"] as const) (result[field] as unknown[]).push(...item[field]);
    result.blockers.push(...item.blockers.filter(blocker => !result.blockers.includes(blocker)));
    (result.fileBlockers ??= []).push(...(item.fileBlockers ?? []));
    Object.assign(result.testPackages, item.testPackages);
    for (const [name, value] of Object.entries(item.performance?.phasesMs ?? {})) phasesMs[name] = (phasesMs[name] ?? 0) + value;
    for (const [name, value] of Object.entries(item.performance?.counts ?? {})) counts[name] = (counts[name] ?? 0) + value;
  }
  return result;
}
