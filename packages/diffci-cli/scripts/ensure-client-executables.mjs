#!/usr/bin/env node
import { chmodSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
for (const path of ["dist-client/src/client/cli.js", "dist-client/src/client/mcp.js"]) {
  chmodSync(join(root, path), 0o755);
}

console.log("Marked packaged DiffCI entry points executable.");
