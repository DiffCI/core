import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { subsetCommand } from "../../src/client/command-batches.js";
import type { OutcomeRecord } from "../../src/client/outcome-log.js";
import { assignShards, parseShard, readTimings, TIMINGS_SCHEMA, timingsFromOutcomes } from "../../src/client/test-shards.js";

test("parses i/N and rejects anything else", () => {
  assert.deepEqual(parseShard("2/3"), { index: 2, total: 3 });
  for (const value of ["0/3", "4/3", "1/0", "a/b", "1-3", "1/"]) assert.equal(parseShard(value), undefined, value);
});

test("every test lands in exactly one shard, the same way every time", () => {
  const tests = Array.from({ length: 23 }, (_, index) => `t${String(index).padStart(2, "0")}.test.js`);
  const shards = assignShards(tests, 4);
  assert.deepEqual(shards.flat().sort(), tests);
  assert.deepEqual(assignShards([...tests].reverse(), 4).map((shard) => [...shard].sort()), shards.map((shard) => [...shard].sort()), "input order does not change the split");
  assert.ok(shards.every((shard) => shard.length === 5 || shard.length === 6), "equal weights split by count");
  assert.deepEqual(assignShards(["a.test.js"], 3), [["a.test.js"], [], []]);
});

test("balances by timings, longest first", () => {
  const timings = { schema: TIMINGS_SCHEMA, files: { "slow.test.js": 100, "a.test.js": 40, "b.test.js": 30, "c.test.js": 30 } };
  assert.deepEqual(assignShards(["a.test.js", "b.test.js", "c.test.js", "slow.test.js"], 2, timings), [["slow.test.js"], ["a.test.js", "b.test.js", "c.test.js"]]);
  // A file without a timing weighs the median known one.
  const partial = { schema: TIMINGS_SCHEMA, files: { "a.test.js": 10, "b.test.js": 50, "c.test.js": 90 } };
  assert.deepEqual(assignShards(["a.test.js", "b.test.js", "c.test.js", "new.test.js"], 2, partial), [["a.test.js", "c.test.js"], ["b.test.js", "new.test.js"]]);
});

test("timings are each file's median of its last five durations", () => {
  const run = (ms: number[]): OutcomeRecord => ({
    schema: "diffci.outcome.v1", produced_at: "", scope: "working-tree", base_sha: "b", tree_sha: "t", verification: "passed",
    selection: "full", tests_selected: 1, tests_available: 1, fallback_reasons: [],
    test_results: [{ file: "a.test.js", status: "passed", ms: ms[0] }, { file: "b.test.js", status: "passed", ...(ms[1] !== undefined ? { ms: ms[1] } : {}) }],
  });
  const timings = timingsFromOutcomes([run([1000]), run([10, 5]), run([20]), run([30]), run([40]), run([50, 7])]);
  assert.deepEqual(timings, { schema: TIMINGS_SCHEMA, files: { "a.test.js": 30, "b.test.js": 7 } });
});

test("reads only a valid timings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-timings-"));
  try {
    const path = join(dir, "timings.json");
    writeFileSync(path, JSON.stringify({ schema: TIMINGS_SCHEMA, files: { "a.test.js": 12 } }));
    assert.deepEqual(readTimings(path).files, { "a.test.js": 12 });
    writeFileSync(path, JSON.stringify({ files: { "a.test.js": "12" } }));
    assert.throws(() => readTimings(path), /not a diffci\.timings\.v1 file/);
    assert.throws(() => readTimings(join(dir, "missing.json")), /could not read timings file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cuts a command down to the shard's paths, or says it cannot", () => {
  const paths = ["a.test.js", "b.test.js", "c.test.js"];
  assert.equal(subsetCommand("node --test a.test.js b.test.js c.test.js", paths, new Set(["c.test.js", "a.test.js"])), "node --test a.test.js c.test.js");
  assert.equal(subsetCommand("node --test a.test.js b.test.js", paths, new Set(["c.test.js"])), null);
  assert.equal(subsetCommand("npm test", paths, new Set(["a.test.js"])), undefined);
});
