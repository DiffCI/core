// SPDX-License-Identifier: MIT
/**
 * Is a change inside a TypeScript program? (2026-10-29, docs/design/pipeline-impact.md, phase 1 slice 4.)
 *
 * `tsc --noEmit` and type-aware lint check a whole program, so a change anywhere in it can break a file
 * that did not change, and they are never narrowed to files. But a change outside the program (docs, SQL,
 * site HTML, a script no TypeScript imports) cannot change their result, and they can be skipped.
 *
 * THE RULE. The program is the tsconfig's root files (`files`, `include`, `exclude`, inherited through
 * relative `extends`; `projectRoots` in compiled-projects.ts) plus whatever those roots import. A change is
 * in the program when:
 *
 *   - it is a root (added and deleted paths count: they enter or leave the program);
 *   - it is a tsconfig/jsconfig, package.json, a lockfile or any `.d.ts` (they change every file's types);
 *   - it is a file TypeScript can load (TypeScript, JavaScript, JSON) and some root's text names it in an
 *     import-like string (`"./x"`, `"@/lib/x"`, `"../data/x.json"`). TypeScript can only reach a non-root
 *     file through an import that names it.
 *
 * FAILING CLOSED. A tsconfig that cannot be read, or one that extends a package (whose `include` and
 * `allowJs` are unknown) when a JavaScript file changed, counts as in the program.
 */

import { posix } from "node:path";
import { projectRoots } from "../repo/compiled-projects.js";
import { LOCKFILE } from "../repo/lockfiles.js";
import type { NarrowingInput } from "./check-narrowing.js";

const CONFIG = /(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/;
const LOADABLE = /\.(?:[cm]?tsx?|[cm]?jsx?|json)$/;
const JAVASCRIPT = /\.[cm]?jsx?$/;

export type ProgramMembership =
  | { inProgram: true; reason: string }
  | { inProgram: false; reason: string };

/** Root file texts, read once per narrowing pass. */
export type RootTextCache = Map<string, string | undefined>;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The name an import of `path` would end with: its stem, or its directory for an index file. */
function importName(path: string): string {
  const stem = posix.basename(path).replace(/\.(?:d\.)?[^.]+$/, "");
  return stem === "index" && posix.dirname(path) !== "." ? posix.basename(posix.dirname(path)) : stem;
}

export function programMembership(config: string, input: NarrowingInput, cache: RootTextCache = new Map()): ProgramMembership {
  const configText = input.read(config);
  if (configText === undefined) return { inProgram: true, reason: `${config} could not be read` };
  const global = input.changes.find(({ path }) => CONFIG.test(path) || path === "package.json" || LOCKFILE.test(posix.basename(path)) || path.endsWith(".d.ts"));
  if (global) return { inProgram: true, reason: `${global.path} changed, which affects every file's types` };

  // Added and deleted paths are matched too: they enter or leave the program.
  const files = [...new Set([...(input.files ?? []), ...input.changes.map(({ path }) => path)])];
  const roots = projectRoots(config, { files, read: input.read });
  if (!roots) return { inProgram: true, reason: `${config} could not be parsed` };
  const rootSet = new Set(roots);
  const root = input.changes.find(({ path }) => rootSet.has(path));
  if (root) return { inProgram: true, reason: `${root.path} is in the ${config} program` };

  const packageBase = /"extends"\s*:\s*(?:\[[^\]]*)?"[^.]/.test(configText);
  const loadable = input.changes.filter(({ path }) => LOADABLE.test(path));
  if (packageBase) {
    const script = loadable.find(({ path }) => JAVASCRIPT.test(path));
    if (script) return { inProgram: true, reason: `${config} extends a package, so ${script.path} may be compiled` };
  }
  for (const { path } of loadable) {
    const pattern = new RegExp(`["'\`/]${escape(importName(path))}(?:\\.[\\w.]+)?["'\`]`);
    for (const candidate of roots) {
      if (!cache.has(candidate)) cache.set(candidate, input.read(candidate));
      if (pattern.test(cache.get(candidate) ?? "")) return { inProgram: true, reason: `${path} may be imported by ${candidate}` };
    }
  }
  return { inProgram: false, reason: `no changed file is in the ${config} program` };
}

const TSC_VALUE_FLAGS = new Set(["-p", "--project", "--tsBuildInfoFile", "--pretty"]);
const TSC_BOOLEAN_FLAGS = new Set(["--noEmit", "--incremental", "--skipLibCheck", "--extendedDiagnostics", "--diagnostics", "--noErrorTruncation"]);

/** The tsconfig a `tsc` leaf checks, or undefined when the command is not a plain project check. */
export function tscProject(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  let index = 0;
  if (words[index] === "npx") { index++; if (words[index] === "--no-install") index++; }
  if (words[index] !== "tsc") return undefined;
  let project = "tsconfig.json";
  for (index++; index < words.length; index++) {
    const word = words[index]!;
    if (TSC_BOOLEAN_FLAGS.has(word)) continue;
    if (!TSC_VALUE_FLAGS.has(word)) return undefined;
    const value = words[++index];
    if (value === undefined) return undefined;
    if (word === "--pretty" && !/^(?:true|false)$/.test(value)) { index--; continue; }
    if (word === "-p" || word === "--project") {
      if (/["'$`]/.test(value)) return undefined;
      const normalized = posix.normalize(value).replace(/\/$/, "");
      project = normalized.endsWith(".json") ? normalized : posix.join(normalized, "tsconfig.json");
    }
  }
  return project;
}
