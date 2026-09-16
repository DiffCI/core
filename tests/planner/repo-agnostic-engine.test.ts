// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Phase 01's exit criterion includes "zero per-repo code". This makes that enforceable instead of
 * aspirational: it reads the engine's own source and fails if any particular repository has been
 * described inside it.
 *
 * The engine is the path from a commit to a plan - src/git, src/repo, src/planner - plus the shadow
 * entry point that runs it against arbitrary repositories. Everything else (the research corpus, the
 * benchmark harness, operator scripts) legitimately names repositories, because naming which
 * repositories were studied is the point.
 *
 * This is a coarse check by design. It catches the thing that actually happened - a repository's name
 * or its private vocabulary hardcoded into a shared code path - and does not attempt to catch
 * cleverer forms of the same mistake.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = join(dirname(import.meta.filename), "..", "..");

/** Source trees that must describe no particular repository. */
const ENGINE_DIRECTORIES = ["src/git", "src/repo", "src/planner"];

/**
 * Names of specific repositories, and vocabulary that belongs to exactly one of them. Each entry is
 * something that was genuinely present in the engine before Phase 01.
 */
const FORBIDDEN_TERMS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /dentalpresence/i, why: "the origin repository's name" },
  { pattern: /\bwordpress\b/i, why: "a DentalPresence-only CI concern" },
  { pattern: /react-server/i, why: "a Next.js condition from DentalPresence's own runner invocation" },
  { pattern: /validate:aws/i, why: "a DentalPresence-only CI task id" },
  { pattern: /diffci\.com/i, why: "this repository's own name" },
];

/**
 * Comments may name a repository - the reason a rule exists is usually a specific repository it was
 * found on, and deleting that history to satisfy a lint would make the code worse. Only executable
 * source is checked.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: string | undefined;
  while (index < source.length) {
    const ch = source[index]!;
    const next = source[index + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && next !== undefined) { out += next; index += 2; continue; }
      if (ch === quote) quote = undefined;
      index++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; out += ch; index++; continue; }
    if (ch === "/" && next === "/") { while (index < source.length && source[index] !== "\n") index++; continue; }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    out += ch;
    index++;
  }
  return out;
}

function sourceFilesUnder(dir: string): string[] {
  const absolute = join(REPO_ROOT, dir);
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (full.endsWith(".ts")) found.push(full);
    }
  };
  walk(absolute);
  return found;
}

describe("the engine describes no particular repository (Phase 01 exit criterion)", () => {
  it("names no specific repository in executable engine source", () => {
    const violations: string[] = [];

    for (const dir of ENGINE_DIRECTORIES) {
      for (const file of sourceFilesUnder(dir)) {
        const code = stripComments(readFileSync(file, "utf8"));
        for (const { pattern, why } of FORBIDDEN_TERMS) {
          const match = pattern.exec(code);
          if (match) {
            violations.push(`${relative(REPO_ROOT, file)}: "${match[0]}" - ${why}`);
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `engine source must not describe a particular repository:\n  ${violations.join("\n  ")}`,
    );
  });

  it("encodes no particular repository's directory layout in executable engine source", () => {
    // The name-based check above passed for weeks while the engine still described DiffCI
    // STRUCTURALLY: `startsWith("scripts/") || startsWith("ops/")` meant "is this a script",
    // `startsWith("docs/")` meant documentation, and the PATH baseline scoped changes with
    // `src/**`, `scripts/**`, `ops/**`. None of those name a repository; all of them are one.
    //
    // A prefix test against a layout directory is the shape that mistake takes, so it is the shape
    // this forbids. Directory names that classify a file by PURPOSE rather than by where this
    // project happens to put code - infrastructure, database, CI configuration - are allowed, since
    // those are ecosystem-wide conventions and are used as name SETS, not path prefixes.
    const layoutDirectories = ["src", "lib", "app", "pages", "scripts", "ops", "tools", "bin", "tests", "test", "docs"];
    const violations: string[] = [];

    for (const dir of ENGINE_DIRECTORIES) {
      for (const file of sourceFilesUnder(dir)) {
        const code = stripComments(readFileSync(file, "utf8"));
        for (const layoutDir of layoutDirectories) {
          for (const form of [`startsWith("${layoutDir}/")`, `"${layoutDir}/**"`, `'${layoutDir}/'`]) {
            if (code.includes(form)) {
              violations.push(`${relative(REPO_ROOT, file)}: ${form} - hardcodes one repository's layout`);
            }
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `engine source must derive layout from the repository (src/repo/layout.ts), not assume it:\n  ${violations.join("\n  ")}`,
    );
  });

  it("keeps the DentalPresence task list out of src/ entirely", () => {
    // It lived in src/planner/task-registry.ts and was what src/shadow/runner.ts planned every
    // repository against. It is now a test fixture, and nothing under src/ may reach it.
    const importers: string[] = [];
    for (const dir of ["src"]) {
      for (const file of sourceFilesUnder(dir)) {
        const code = readFileSync(file, "utf8");
        if (code.includes("dentalpresence-task-registry")) importers.push(relative(REPO_ROOT, file));
      }
    }
    assert.deepEqual(importers, [], "production code must not import a repository-specific fixture");
  });
});
