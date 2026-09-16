// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import { analyzeGitDelta, EMPTY_TREE_SHA, gitDeltaToJson } from "../../src/git/git-diff.js";

function createTempGitRepo(): string {
  const dir = join(tmpdir(), `diffci-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'test@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Test User'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  return dir;
}

function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath });
  execSync(`git commit --quiet -m "${message}"`, { cwd: repoPath });
}

function getSha(repoPath: string, ref = "HEAD"): string {
  return execSync(`git rev-parse ${ref}`, { cwd: repoPath, encoding: "utf8" }).trim();
}

describe("analyzeGitDelta temp repo", () => {
  let repoPath: string;

  before(() => {
    repoPath = createTempGitRepo();
    writeFileSync(join(repoPath, "initial.txt"), "hello\n");
    commitAll(repoPath, "initial");
  });

  after(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns an empty delta for identical base and head", async () => {
    const sha = getSha(repoPath);
    const result = await analyzeGitDelta({ repoPath, baseSha: sha, headSha: sha });
    assert.strictEqual(result.success, true);
    if (!result.success) return;
    assert.strictEqual(result.delta.files.length, 0);
    assert.strictEqual(result.delta.analysis.empty, true);
  });

  it("detects added and modified files", async () => {
    writeFileSync(join(repoPath, "added.txt"), "added content\n");
    writeFileSync(join(repoPath, "initial.txt"), "hello world\n");
    const base = getSha(repoPath);
    commitAll(repoPath, "change files");
    const headSha = getSha(repoPath);

    const result = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
    assert.strictEqual(result.success, true);
    if (!result.success) return;

    const paths = result.delta.files.map((f) => f.path).sort();
    assert.deepStrictEqual(paths, ["added.txt", "initial.txt"]);
  });

  it("detects deleted files", async () => {
    writeFileSync(join(repoPath, "deleted.txt"), "temporary\n");
    commitAll(repoPath, "before delete");
    const deleteBase = getSha(repoPath);
    execSync("git rm --quiet deleted.txt", { cwd: repoPath });
    commitAll(repoPath, "delete file");
    const deleteHead = getSha(repoPath);

    const result = await analyzeGitDelta({ repoPath, baseSha: deleteBase, headSha: deleteHead });
    assert.strictEqual(result.success, true);
    if (!result.success) return;
    assert.strictEqual(result.delta.files.length, 1);
    assert.strictEqual(result.delta.files[0]?.changeType, "deleted");
  });

  it("detects renamed files", async () => {
    writeFileSync(join(repoPath, "rename-me.txt"), "content that stays\n");
    commitAll(repoPath, "create rename source");
    const base = getSha(repoPath);
    execSync("git mv rename-me.txt renamed.txt", { cwd: repoPath });
    commitAll(repoPath, "rename file");
    const headSha = getSha(repoPath);

    const result = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
    assert.strictEqual(result.success, true);
    if (!result.success) return;

    assert.strictEqual(result.delta.files.length, 1);
    assert.strictEqual(result.delta.files[0]?.changeType, "renamed");
    assert.strictEqual(result.delta.files[0]?.oldPath, "rename-me.txt");
    assert.strictEqual(result.delta.files[0]?.path, "renamed.txt");
  });

  it("detects binary files", async () => {
    writeFileSync(join(repoPath, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const base = getSha(repoPath);
    commitAll(repoPath, "add binary file");
    const headSha = getSha(repoPath);

    const result = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
    assert.strictEqual(result.success, true);
    if (!result.success) return;

    const binaryFile = result.delta.files.find((f) => f.path === "data.bin");
    assert.strictEqual(binaryFile?.changeType, "added");
    assert.strictEqual(binaryFile?.isBinary, true);
  });

  it("handles paths with spaces", async () => {
    const fileName = "file with spaces.txt";
    writeFileSync(join(repoPath, fileName), "spaced content\n");
    const base = getSha(repoPath);
    commitAll(repoPath, "add spaced file");
    const headSha = getSha(repoPath);

    const result = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
    assert.strictEqual(result.success, true);
    if (!result.success) return;

    assert.strictEqual(result.delta.files[0]?.path, fileName);
    assert.strictEqual(result.delta.files[0]?.changeType, "added");
  });

  it("produces deterministic JSON output", async () => {
    const base = getSha(repoPath, "HEAD~2");
    const headSha = getSha(repoPath);

    const first = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
    const second = await analyzeGitDelta({ repoPath, baseSha: base, headSha });

    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
    if (!first.success || !second.success) return;

    assert.strictEqual(gitDeltaToJson(first.delta), gitDeltaToJson(second.delta));
  });

  it("analyzes a parent-less (initial) commit using the empty tree base", async () => {
    const firstCommit = execSync("git rev-list --max-parents=0 HEAD", { cwd: repoPath, encoding: "utf8" }).trim();
    const result = await analyzeGitDelta({ repoPath, baseSha: EMPTY_TREE_SHA, headSha: firstCommit });

    assert.strictEqual(result.success, true);
    if (!result.success) return;

    assert.ok(result.delta.files.length > 0, "expected files in initial commit");
    assert.strictEqual(result.delta.analysis.empty, false);
  });

  it("reports failure for invalid SHAs", async () => {
    const result = await analyzeGitDelta({
      repoPath,
      baseSha: "0000000000000000000000000000000000000000",
      headSha: getSha(repoPath),
    });
    assert.strictEqual(result.success, false);
    if (result.success) return;
    assert.ok(result.error.length > 0);
  });

  // Stage 1B regression tests (2026-08-21, docs/research/2026-08-21-stage1b-*.md): package.json
  // field-level diffing. Root-caused in Stage 1A's fallback-composition analysis: any change to the
  // root package.json unconditionally set dependencyManifestChanged=true, including metadata-only
  // fields (description, author, etc.) with zero behavioral effect. Real git repo, real commits - not
  // a mock - so this exercises the actual `git show <sha>:package.json` content read end to end.
  describe("dependencyManifestChanged field-level narrowing", () => {
    it("does not set dependencyManifestChanged for a metadata-only package.json change", async () => {
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", description: "old description" }));
      commitAll(repoPath, "seed package.json");
      const base = getSha(repoPath);

      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", description: "new description", author: "someone" }));
      commitAll(repoPath, "metadata-only package.json change");
      const headSha = getSha(repoPath);

      const result = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
      assert.strictEqual(result.success, true);
      if (!result.success) return;
      assert.strictEqual(result.delta.analysis.dependencyManifestChanged, false, "description/author are not behaviorally-relevant fields");
    });

    it("still sets dependencyManifestChanged when dependencies actually change", async () => {
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } }));
      commitAll(repoPath, "seed package.json with a dependency");
      const base = getSha(repoPath);

      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.0.0", "right-pad": "2.0.0" } }));
      commitAll(repoPath, "add a real dependency");
      const headSha = getSha(repoPath);

      const result = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
      assert.strictEqual(result.success, true);
      if (!result.success) return;
      assert.strictEqual(result.delta.analysis.dependencyManifestChanged, true, "a real dependencies change must still trigger fallback");
    });

    it("still sets dependencyManifestChanged when package.json is newly added (nothing to narrow against)", async () => {
      const base = getSha(repoPath);
      writeFileSync(join(repoPath, "newly-added-package.json.marker"), "x"); // avoid an empty-diff edge case
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "brand-new", version: "0.0.1" }));
      commitAll(repoPath, "add package.json for the first time");
      const headSha = getSha(repoPath);

      const result = await analyzeGitDelta({ repoPath, baseSha: base, headSha });
      assert.strictEqual(result.success, true);
      if (!result.success) return;
      assert.strictEqual(result.delta.analysis.dependencyManifestChanged, true, "an added package.json has no 'before' state to narrow against - must stay conservative");
    });
  });
});
