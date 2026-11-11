// SPDX-License-Identifier: MIT
/**
 * Every `CONFIG_PATTERNS` entry matches a real configuration file name (issue #100).
 *
 * `/^eslint\.rc/` matched no file ESLint reads (the legacy files are `.eslintrc*`, which `/^\.eslint/`
 * covers), and nothing noticed. This table pairs each entry with one real file name, in order, so a
 * pattern that no longer matches its example, or a new entry without one, fails here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIG_PATTERNS } from "../../src/git/git-diff.js";

const EXAMPLES = [
  "next.config.mjs",
  "tsconfig.json",
  "jsconfig.json",
  "eslint.config.js",
  ".eslintrc.json",
  "postcss.config.cjs",
  "tailwind.config.ts",
  ".prettierrc",
  "prettier.config.js",
  "vitest.config.ts",
  "jest.config.js",
  "playwright.config.ts",
  "webpack.config.js",
  "rollup.config.mjs",
  "esbuild.config.js",
  ".github/workflows/ci.yml",
  ".dockerignore",
  "Dockerfile.dev",
  "docker-compose.yml",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "npm-lock.json",
  "pyproject.toml",
  "setup.cfg",
  "pytest.ini",
  "tox.ini",
  "noxfile.py",
  "requirements-dev.txt",
  "Pipfile.lock",
  "uv.lock",
  ".python-version",
];

test("every CONFIG_PATTERNS entry has one real file name in the table", () => {
  assert.equal(EXAMPLES.length, CONFIG_PATTERNS.length);
});

CONFIG_PATTERNS.forEach((pattern, i) => {
  test(`${pattern} matches ${EXAMPLES[i]}`, () => {
    assert.match(EXAMPLES[i] ?? "", pattern);
  });
});

test("no entry matches the file name ESLint never reads", () => {
  assert.ok(!CONFIG_PATTERNS.some((pattern) => pattern.test("eslint.rc")));
});
