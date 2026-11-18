import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildClient } from "../helpers/build-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Test files run in parallel processes; a test that rebuilt dist-client rewrote the modules another
// test's CLI was loading ("SyntaxError: Unexpected end of input" in dist-client/src/preflight/fingerprint.js).
it("no test file compiles dist-client itself; they share buildClient", () => {
  const config = `"${["tsconfig", "client", "json"].join(".")}"`;
  const direct = readdirSync(join(ROOT, "tests", "client"))
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => readFileSync(join(ROOT, "tests", "client", name), "utf8").includes(config));
  assert.deepEqual(direct, []);
});

it("buildClient leaves an up-to-date dist-client untouched", () => {
  buildClient();
  const cli = join(ROOT, "dist-client", "src", "client", "cli.js");
  const before = statSync(cli).mtimeMs;
  buildClient();
  assert.equal(statSync(cli).mtimeMs, before);
});
