import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";

test("Vue cache preserves graphs through warm reuse, changed imports/types, configuration and corruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "diffci-vue-cache-"));
  const repo = join(root, "repo"); const cache = join(root, "cache");
  const put = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  put("package.json", '{"devDependencies":{"vitest":"1"}}');
  put("tsconfig.json", '{"compilerOptions":{"moduleResolution":"Bundler","module":"ESNext"},"include":["src","tests"]}');
  put("src/types.ts", 'export interface Props { title: string }');
  put("src/value.ts", 'export const value = 1;');
  put("src/Typed.vue", '<script setup lang="ts">import type { Props } from "./types"; defineProps<Props>();</script><template><div>{{ title }}</div></template>');
  put("src/Plain.vue", '<script setup lang="ts">import { value } from "./value";</script><template><div>{{ value }}</div></template>');
  put("tests/main.test.ts", 'import A from "../src/Typed.vue"; import B from "../src/Plain.vue";');
  const identity = (r: Awaited<ReturnType<typeof buildDependencyGraph>>) => JSON.stringify({ nodes: r.graph.nodes, edges: r.graph.edges, blockers: r.adapterBlockers, confidence: r.confidence, unresolved: r.unresolved, tests: r.profile.testFilePaths });
  const compare = async (directory = cache) => {
    const clean = await buildDependencyGraph({ repoPath: repo });
    const cached = await buildDependencyGraph({ repoPath: repo, vueAnalysisCache: { directory, version: "test" } });
    assert.equal(identity(cached), identity(clean));
    return cached.performance.adapterMetrics?.vue.counts;
  };
  try {
    assert.equal((await compare())?.cacheMisses, 2);
    assert.equal((await compare())?.cacheHits, 2);
    put("src/types.ts", 'export interface Props { title: number; active?: boolean }');
    const changed = await compare(); assert.equal(changed?.cacheMisses, 1); assert.equal(changed?.cacheHits, 1);
    put("src/Plain.vue", '<script setup lang="ts">import A from "./Typed.vue";</script><template><A title="x" /></template>');
    assert.equal((await compare())?.cacheMisses, 1);
    put("src/Typed.vue", '<script setup lang="ts">import type { Missing } from "./missing"; defineProps<Missing>();</script>');
    await compare(); await compare();
    put("src/missing.ts", 'export interface Missing { value: string }');
    assert.equal((await compare())?.cacheMisses, 2);
    put("package.json", '{"devDependencies":{"vitest":"2"}}');
    assert.equal((await compare())?.cacheMisses, 2);
    for (const name of readdirSync(cache)) writeFileSync(join(cache, name), '{"broken":');
    assert.equal((await compare())?.cacheMisses, 2);
    rmSync(join(repo, "src/Plain.vue")); await compare();
    const inside = join(repo, "..cache"); await compare(inside);
    assert.throws(() => readdirSync(inside));
    if (process.platform !== "win32") {
      const alias = join(root, "alias"); symlinkSync(repo, alias);
      await compare(join(alias, "cache")); assert.throws(() => readdirSync(join(repo, "cache")));
    }
    // A cache I/O failure must preserve the uncached result.
    const unwritable = join(root, "file"); writeFileSync(unwritable, "not a directory"); await compare(unwritable);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
