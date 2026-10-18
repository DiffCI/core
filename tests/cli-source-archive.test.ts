// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

type SourceArchive = {
  schema: string;
  package: string;
  version: string;
  sourceCommit: string;
  npm: { shasum: string; integrity: string };
  files: Array<{ path: string; sha256: string }>;
};

test("v0.3.10 CLI source archive remains complete and hash-bound", async () => {
  const root = new URL("../packages/diffci-cli/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("SOURCE-MANIFEST.json", root), "utf8")) as SourceArchive;

  assert.equal(manifest.schema, "diffci.source-archive.v1");
  assert.equal(manifest.package, "@diffci.com/diffci");
  assert.equal(manifest.version, "0.3.10");
  assert.equal(manifest.sourceCommit, "c2314eb9dfb965ca1e6a17ef1ccffe9f5843eea6");
  assert.equal(manifest.npm.shasum, "41dda3e616ff374888be2278981126836083b5a3");
  assert.equal(manifest.npm.integrity, "sha512-uQcS9/ICMo4VCmvx7j829AdWMjJkUdcaiRegxRDc9orUrQBkhNqr2dmRlxlXd+hMRqX85KourasUfBUs5JeSNg==");
  assert.ok(manifest.files.length >= 27, "source archive must include its build metadata and executable closure");

  for (const file of manifest.files) {
    const contents = await readFile(new URL(file.path, root));
    const actual = createHash("sha256").update(contents).digest("hex");
    assert.equal(actual, file.sha256, `source archive digest mismatch for ${file.path}`);
  }
});
