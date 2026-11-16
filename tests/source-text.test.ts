// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("source text", () => {
  // A raw NUL byte makes git, grep and ripgrep treat the file as binary, so searches miss it. Use the "\0" escape.
  it("has no raw NUL byte in a TypeScript source file", () => {
    const files = [...tsFiles(join(root, "src")), ...tsFiles(join(root, "packages", "diffci-cli", "src"))];
    assert.ok(files.length > 50, `only ${files.length} source files found; the walk is probably broken`);
    const withNul = files.filter((file) => readFileSync(file).includes(0)).map((file) => relative(root, file));
    assert.deepEqual(withNul, [], 'replace the raw NUL byte with the "\\0" escape');
  });
});
