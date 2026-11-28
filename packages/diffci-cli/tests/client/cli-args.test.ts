import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseArgs } from "../../src/client/cli-args.js";

const parse = (...args: string[]) => parseArgs(["node", "diffci", ...args]);

describe("parseArgs", () => {
  it("reads --name value and --name=value the same way", () => {
    const spaced = parse("verify", "--policy", "enforce", "--timeout-ms", "600000", "--shard", "1/2", "--json");
    const equals = parse("verify", "--policy=enforce", "--timeout-ms=600000", "--shard=1/2", "--json");
    assert.deepEqual(equals, spaced);
    assert.deepEqual(equals.flags, { policy: "enforce", "timeout-ms": "600000", shard: "1/2", json: true });
  });

  it("passes an invalid --name=value through so the command rejects it", () => {
    assert.equal(parse("verify", "--policy=bogus").flags.policy, "bogus");
  });

  it("keeps everything after the first = as the value", () => {
    assert.equal(parse("verify", "--base=a=b").flags.base, "a=b");
    assert.equal(parse("verify", "--out=").flags.out, "");
  });

  it("does not take the next token after --name=value", () => {
    assert.deepEqual(parse("verify", "--policy=enforce", "extra"), { command: "verify", flags: { policy: "enforce" } });
  });

  it("collects --paths in both forms", () => {
    assert.equal(parse("verify", "--paths", "a.ts", "b.ts").flags.paths, "a.ts\0b.ts");
    assert.equal(parse("verify", "--paths=a.ts", "b.ts").flags.paths, "a.ts\0b.ts");
    assert.equal(parse("verify", "--paths=a.ts", "--paths=c.ts").flags.paths, "a.ts\0c.ts");
    assert.equal(parse("verify", "--paths").flags.paths, true);
  });
});
