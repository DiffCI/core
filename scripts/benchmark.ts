// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDependencyGraph } from "../src/repo/graph.js";
import { measure } from "../src/measurement.js";

const root = mkdtempSync(join(tmpdir(), "diffci-core-benchmark-"));
try {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "synthetic-benchmark", type: "module" }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }));
  for (let i = 0; i < 100; i++) {
    writeFileSync(join(root, `src/module${i}.ts`), i ? `import { value as prior } from './module${i - 1}.js';\nexport const value = prior + 1;\n` : "export const value = 0;\n");
    writeFileSync(join(root, `src/module${i}.test.ts`), `import { value } from './module${i}.js';\nif (value !== ${i}) throw new Error('unexpected');\n`);
  }
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const { value, measurement } = await measure(() => buildDependencyGraph({ repoPath: root }));
    runs.push({ ...measurement, nodes: value.graph.nodes.length, edges: value.graph.edges.length, confidence: value.confidence });
  }
  console.log(JSON.stringify({ fixture: "synthetic-chain-100-modules-100-tests", node: process.version, platform: process.platform,
    note: "Graph analysis only; not CI savings, billing, energy or carbon measurements. Runs include process warmup effects.", runs }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
