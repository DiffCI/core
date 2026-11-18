// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";

import { expandMatrix } from "../../src/ci-inference/matrix.js";

// GitHub's documented `include` rules ("Expanding or adding matrix configurations"): an include is added to
// every ORIGINAL combination whose original values it does not overwrite, values added by an earlier include
// can be overwritten, and an include that fits no original combination becomes a new one.
test("matrix include follows GitHub's documented expansion example", () => {
  const { instances, unsupported } = expandMatrix({
    fruit: ["apple", "pear"],
    animal: ["cat", "dog"],
    include: [
      { color: "green" },
      { color: "pink", animal: "cat" },
      { fruit: "apple", shape: "circle" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ],
  });
  assert.deepEqual(unsupported, []);
  assert.deepEqual(instances, [
    { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
    { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
    { fruit: "pear", animal: "cat", color: "pink" },
    { fruit: "pear", animal: "dog", color: "green" },
    { fruit: "banana" },
    { fruit: "banana", animal: "cat" },
  ]);
});

test("an include overwrites a value an earlier include added, never an original one", () => {
  const { instances } = expandMatrix({
    node: ["18", "20"],
    include: [{ experimental: "false" }, { node: "20", experimental: "true" }, { node: "22" }],
  });
  assert.deepEqual(instances, [
    { node: "18", experimental: "false" },
    { node: "20", experimental: "true" },
    { node: "22" },
  ]);
});

test("a matrix of only include entries has one cell per entry", () => {
  const { instances } = expandMatrix({ include: [{ os: "ubuntu-latest" }, { node: "20" }] });
  assert.deepEqual(instances, [{ os: "ubuntu-latest" }, { node: "20" }]);
});

test("exclude still runs before include", () => {
  const { instances } = expandMatrix({
    os: ["ubuntu", "windows"],
    node: ["18", "20"],
    exclude: [{ os: "windows", node: "18" }],
    include: [{ os: "windows", node: "18", legacy: "true" }],
  });
  assert.deepEqual(instances, [
    { os: "ubuntu", node: "18" },
    { os: "ubuntu", node: "20" },
    { os: "windows", node: "20" },
    { os: "windows", node: "18", legacy: "true" },
  ]);
});
