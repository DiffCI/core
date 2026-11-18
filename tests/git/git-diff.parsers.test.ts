// SPDX-License-Identifier: MIT
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  normalizeDirectories,
  parseNameStatus,
  parseNumstat,
} from "../../src/git/git-diff.js";

function buildNameStatus(...files: Array<[string, string?, string?]>): Buffer {
  const parts: string[] = [];
  for (const [status, path1, path2] of files) {
    parts.push(status);
    parts.push(path1 ?? "");
    if (path2) {
      parts.push(path2);
    }
  }
  return Buffer.from(parts.join("\0"), "utf8");
}

function buildNumstat(...entries: Array<[string, string, string?]>): Buffer {
  const parts: string[] = [];
  for (const [count, path1, path2] of entries) {
    const record = path2 ? `${count}\t${path1}\t${path2}` : `${count}\t${path1}`;
    parts.push(record);
  }
  return Buffer.from(parts.join("\0"), "utf8");
}

describe("parseNameStatus", () => {
  it("parses modified, added, and deleted files", () => {
    const buffer = buildNameStatus(
      ["M", "src/components/Button.tsx"],
      ["A", "src/utils/math.ts"],
      ["D", "src/legacy/old.ts"],
    );
    const files = parseNameStatus(buffer);
    assert.deepStrictEqual(files, [
      { path: "src/components/Button.tsx", changeType: "modified" },
      { path: "src/utils/math.ts", changeType: "added" },
      { path: "src/legacy/old.ts", changeType: "deleted" },
    ]);
  });

  it("parses renames with similarity score", () => {
    const buffer = buildNameStatus(["R095", "src/old.tsx", "src/new.tsx"]);
    const files = parseNameStatus(buffer);
    assert.deepStrictEqual(files, [
      {
        path: "src/new.tsx",
        oldPath: "src/old.tsx",
        changeType: "renamed",
        similarityScore: 95,
      },
    ]);
  });

  it("handles paths containing spaces", () => {
    const buffer = buildNameStatus(["A", "docs/my document with spaces.md"]);
    const files = parseNameStatus(buffer);
    assert.strictEqual(files[0]?.path, "docs/my document with spaces.md");
    assert.strictEqual(files[0]?.changeType, "added");
  });

  it("returns an empty array for an empty buffer", () => {
    const files = parseNameStatus(Buffer.from(""));
    assert.deepStrictEqual(files, []);
  });
});

describe("parseNumstat", () => {
  it("detects text and binary files", () => {
    const buffer = buildNumstat(
      ["12\t3", "src/text.ts"],
      ["-\t-", "src/image.png"],
    );
    const map = parseNumstat(buffer);
    assert.strictEqual(map.get("src/text.ts"), false);
    assert.strictEqual(map.get("src/image.png"), true);
  });

  // `git diff-tree --numstat -z` writes a rename or copy as "added\tdeleted\t" with an empty path, then
  // the old and new paths as their own NUL-terminated fields (#175).
  it("handles rename numstat records in git's -z format", () => {
    const buffer = Buffer.from("5\t2\t\0src/old.ts\0src/new.ts\0-\t-\t\0bin/data.bin\0bin/moved.bin\0", "utf8");
    const map = parseNumstat(buffer);
    assert.strictEqual(map.get("src/new.ts"), false);
    assert.strictEqual(map.get("bin/moved.bin"), true);
    assert.deepStrictEqual([...map.keys()].sort(), ["bin/moved.bin", "src/new.ts"]);
  });

  it("keeps a tab inside a path, which -z leaves unquoted", () => {
    const map = parseNumstat(Buffer.from("1\t1\tdocs/a\tb.md\0-\t-\t\0x.bin\0y\tz.bin\0", "utf8"));
    assert.deepStrictEqual([...map.entries()], [["docs/a\tb.md", false], ["y\tz.bin", true]]);
  });
});

describe("normalizeDirectories", () => {
  it("extracts and deduplicates directories", () => {
    const dirs = normalizeDirectories([
      "src/components/Button.tsx",
      "src/components/Input.tsx",
      "src/lib/auth.ts",
    ]);
    assert.deepStrictEqual(dirs, ["src/components", "src/lib"]);
  });
});
