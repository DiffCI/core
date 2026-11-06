// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { buildDependencyGraph } from "../../src/repo/graph.js";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import { repositoryFileReader } from "../../src/repo/file-references.js";
import type { ImpactResult } from "../../src/repo/impact-types.js";

const base = {
  "package.json": JSON.stringify({ name: "f", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src", "tests"] }),
  "src/button.tsx": "import styles from './button.module.css';\nexport const button = styles;\n",
  "src/button.module.css": ".a { color: red; }\n",
  "src/other.ts": "export const other = 1;\n",
  "tests/button.test.ts": "import { button } from '../src/button';\nexport { button };\n",
  "tests/other.test.ts": "import { other } from '../src/other';\nexport { other };\n",
};

/** Commits `base`, then `head` (null deletes a path), and analyses the delta like analyzeCheckout. */
async function analyzeChange(head: Record<string, string | null>, start: Record<string, string> = base): Promise<ImpactResult> {
  const dir = join(tmpdir(), `diffci-removed-${randomUUID()}`);
  const write = (entries: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(entries)) {
      if (content === null) { rmSync(join(dir, path)); continue; }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  try {
    mkdirSync(dir, { recursive: true });
    execSync("git init -q && git config user.email t@diffci.local && git config user.name t && git config core.autocrlf false", { cwd: dir });
    write(start);
    execSync("git add -A && git commit -qm base", { cwd: dir });
    const baseSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    write(head);
    execSync("git add -A && git commit -qm head", { cwd: dir });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const delta = await analyzeGitDelta({ repoPath: dir, baseSha, headSha });
    assert.ok(delta.success);
    const graph = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules", ".git"] });
    return new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files, readRepositoryFile: repositoryFileReader(dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const selected = (impact: ImpactResult) => impact.affectedTests.map((test) => test.path).sort();

describe("fallback details", () => {
  it("explains an unknown file with every blocker and the readers leading to it", async () => {
    const action = "runs:\n  using: composite\n  steps:\n    - run: bash scripts/load.sh\n      shell: bash\n";
    const impact = await analyzeChange({ "data/seed.json": "{ \"v\": 2 }\n" }, {
      ...base,
      "data/seed.json": "{ \"v\": 1 }\n",
      "scripts/load.sh": "cat data/seed.json\n",
      ".github/actions/load/action.yml": action,
    });
    assert.equal(impact.fallbackRequired, true);
    assert.deepEqual(impact.fallbackDetails, { "data/seed.json": [".github/actions/load/action.yml names scripts/load.sh (via scripts/load.sh)"] });
  });
});

describe("files gone at HEAD", () => {
  it("narrows a CSS module renamed to plain CSS when its importer moved to the new name", async () => {
    // A composite action naming `src` is an unresolvable reader of every file below it, so the old path
    // used to fall back; a file gone at HEAD is not matched through its directories.
    const impact = await analyzeChange({
      "src/button.module.css": null,
      "src/button.css": ".a { color: red; }\n",
      "src/button.tsx": "import './button.css';\nexport const button = 1;\n",
    }, { ...base, ".github/actions/build/action.yml": "runs:\n  using: composite\n  steps:\n    - run: ls ./src/\n      shell: bash\n" });
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
    assert.deepEqual(selected(impact), ["tests/button.test.ts"]);
  });

  it("narrows a deleted CSS module whose importer dropped it", async () => {
    const impact = await analyzeChange({ "src/button.module.css": null, "src/button.tsx": "export const button = 1;\n" });
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
    assert.deepEqual(selected(impact), ["tests/button.test.ts"]);
  });

  it("skips a file too large to read rather than treating it as an unknown reader", async () => {
    const impact = await analyzeChange({ "src/button.module.css": null, "src/button.tsx": "export const button = 1;\n" }, {
      ...base,
      "db/meta/snapshot.json": JSON.stringify({ blob: "x".repeat(1_100_000) }),
    });
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
    assert.deepEqual(selected(impact), ["tests/button.test.ts"]);
  });

  it("falls back when an unchanged file still imports the deleted path", async () => {
    const impact = await analyzeChange({ "src/button.module.css": null });
    assert.equal(impact.fallbackRequired, true);
    assert.ok(impact.riskSignals.some((signal) => signal.reason === "DELETED_FILE_UNKNOWABLE_GRAPH"));
  });

  it("selects the tests of a sibling that now resolves the deleted module's imports", async () => {
    const impact = await analyzeChange({ "src/other.ts": null }, {
      ...base,
      "src/other/index.ts": "export const other = 2;\n",
      "tests/index.test.ts": "import { other } from '../src/other/index';\nexport { other };\n",
    });
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
    assert.deepEqual(selected(impact), ["tests/index.test.ts", "tests/other.test.ts"]);
  });

  it("selects a test that names the deleted file", async () => {
    const impact = await analyzeChange({ "src/button.module.css": null, "src/button.tsx": "export const button = 1;\n" }, {
      ...base,
      "tests/styles.test.ts": "import { existsSync } from 'node:fs';\nexport const legacy = existsSync('src/button.module.css');\n",
    });
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
    assert.deepEqual(selected(impact), ["tests/button.test.ts", "tests/styles.test.ts"]);
  });
});

describe("asset fixtures", () => {
  it("claims a JSON fixture beside its tests before resolving readers", async () => {
    const start = {
      ...base,
      "src/spawn/run.ts": "export const run = 1;\n",
      "src/spawn/run.test.ts": "import { run } from './run';\nexport { run };\n",
      "src/spawn/__fixtures__/acp/handshake.json": "{ \"v\": 1 }\n",
      ".github/actions/build/action.yml": "runs:\n  using: composite\n  steps:\n    - run: ls ./src/\n      shell: bash\n",
    };
    const impact = await analyzeChange({ "src/spawn/__fixtures__/acp/handshake.json": "{ \"v\": 2 }\n" }, start);
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
    assert.deepEqual(selected(impact), ["src/spawn/run.test.ts"]);
  });
});
