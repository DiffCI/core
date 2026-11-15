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
import { LOCKFILE_NAMES } from "../../src/repo/lockfiles.js";
import type { ImpactResult } from "../../src/repo/impact-types.js";

const manifest = (dependencies: Record<string, string>, scripts: Record<string, string> = { test: "vitest run" }) =>
  `${JSON.stringify({ name: "@x/a", version: "1.0.0", scripts, dependencies }, null, 2)}\n`;

const base: Record<string, string> = {
  "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["packages"] }),
  "packages/a/package.json": manifest({ "left-pad": "^1.0.0", "@x/b": "workspace:*" }),
  "packages/a/src/pad.ts": "import leftPad from 'left-pad';\nexport const pad = (s: string) => leftPad(s, 4);\n",
  "packages/a/src/other.ts": "export const other = 1;\n",
  "packages/a/tests/pad.test.ts": "import { pad } from '../src/pad';\nexport { pad };\n",
  "packages/a/tests/other.test.ts": "import { other } from '../src/other';\nexport { other };\n",
};

/** Commits `start`, then `head` over it, and analyses the delta like analyzeCheckout. */
async function analyzeChange(head: Record<string, string>, start: Record<string, string> = base): Promise<ImpactResult> {
  const dir = join(tmpdir(), `diffci-nolock-${randomUUID()}`);
  const write = (entries: Record<string, string>) => {
    for (const [path, content] of Object.entries(entries)) {
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

describe("dependency requests without a lockfile", () => {
  it("narrows a workspace package's dependency bump to the tests of its importers", async () => {
    const impact = await analyzeChange({ "packages/a/package.json": manifest({ "left-pad": "^1.3.0", "@x/b": "workspace:*" }) });
    assert.equal(impact.fallbackRequired, false, impact.fallbackReasons.join("\n"));
    assert.deepEqual(selected(impact), ["packages/a/tests/pad.test.ts"]);
  });

  it("keeps the full suite when a lockfile governs the manifest", async () => {
    const impact = await analyzeChange({ "packages/a/package.json": manifest({ "left-pad": "^1.3.0", "@x/b": "workspace:*" }) }, { ...base, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    assert.equal(impact.fallbackRequired, true);
  });

  it("treats every shared lockfile name, at the root or beside the manifest, as governing it (issue #97)", async () => {
    for (const name of LOCKFILE_NAMES) {
      for (const path of [name, `packages/a/${name}`]) {
        const impact = await analyzeChange({ "packages/a/package.json": manifest({ "left-pad": "^1.3.0", "@x/b": "workspace:*" }) }, { ...base, [path]: "lockfile\n" });
        assert.equal(impact.fallbackRequired, true, path);
      }
    }
  });

  it("keeps the full suite for a local request or a scripts edit", async () => {
    const local = await analyzeChange({ "packages/a/package.json": manifest({ "left-pad": "^1.0.0", "@x/b": "workspace:^" }) });
    assert.equal(local.fallbackRequired, true);
    const scripts = await analyzeChange({ "packages/a/package.json": manifest({ "left-pad": "^1.3.0", "@x/b": "workspace:*" }, { test: "vitest run --pool forks" }) });
    assert.equal(scripts.fallbackRequired, true);
  });
});
