// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reference resolution — follows what a step depends on, and says plainly what it could not follow.
 *
 * Reads the repository. Fetches nothing: a third-party action is `UNRESOLVABLE` from repository evidence
 * alone, and saying so is the correct answer rather than a limitation to paper over.
 *
 * Script following is recursive because real pipelines are: `npm run validate` may be
 * `kcd-scripts validate`, which is an opaque binary, and the honest terminal state is "this resolves to
 * a tool whose behaviour is not in this repository" — which is exactly the `jest-dom` case that
 * INFERENCE_01 reported as a clean win.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EvidenceRef, ObservedFact } from "./schema.js";
import type { ReferenceNode } from "./reference-graph.js";

/** Binaries that orchestrate a project's whole toolchain and cannot be decomposed by reading it. */
const OPAQUE_WRAPPERS = /^(kcd-scripts|react-scripts|nx|turbo|lerna|ut|rush|nps)\b/;

/** `${{ ... }}` expressions and shell variables that repository evidence cannot settle. */
const EXPRESSION = /\$\{\{\s*([^}]+?)\s*\}\}/g;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Resets node ids so two runs over one tree produce identical graphs. */
export function resetReferenceIds(): void {
  counter = 0;
}

/**
 * Every `${{ }}` expression in a command becomes a node.
 *
 * `matrix.*` is a MATRIX_EXPANSION — knowable in principle by expanding the matrix, so UNRESOLVED.
 * `secrets.*` is an ENV_REFERENCE that repository evidence can never supply, so UNRESOLVABLE.
 */
export function expressionReferences(command: string, evidence: EvidenceRef): ReferenceNode[] {
  const nodes: ReferenceNode[] = [];
  for (const match of command.matchAll(EXPRESSION)) {
    const expr = match[1]!;
    const isMatrix = /^matrix\./.test(expr);
    const isSecret = /^secrets\./.test(expr);
    nodes.push({
      id: nextId(isMatrix ? "matrix" : "env"),
      kind: isMatrix ? "MATRIX_EXPANSION" : "ENV_REFERENCE",
      identifier: expr,
      resolution: isSecret ? "UNRESOLVABLE" : "UNRESOLVED",
      reason: isMatrix
        ? "the concrete command depends on a matrix value that has not been expanded"
        : isSecret
          ? "a secret is not present in the repository and cannot be supplied from evidence"
          : "the expression refers to context this engine has not resolved",
      evidence: [evidence],
      dependsOn: [],
      unmet: [isMatrix ? "matrix expansion" : "value of the referenced context"],
    });
  }
  return nodes;
}

/**
 * Follows `npm run <script>` through package.json, recursively.
 *
 * Terminates on: a script that is a plain command (RESOLVED), a script that invokes an opaque wrapper
 * (UNRESOLVABLE), a missing script (UNRESOLVED), or a cycle.
 */
export function resolveScript(repoPath: string, scriptName: string, evidence: EvidenceRef, seen = new Set<string>()): ReferenceNode[] {
  const id = nextId("script");
  const base: ReferenceNode = {
    id,
    kind: "SCRIPT_REFERENCE",
    identifier: scriptName,
    resolution: "UNRESOLVED",
    evidence: [evidence],
    dependsOn: [],
    unmet: [],
  };

  if (seen.has(scriptName)) {
    return [{ ...base, resolution: "UNRESOLVABLE", reason: `script cycle through ${scriptName}`, unmet: ["a terminating script chain"] }];
  }
  seen.add(scriptName);

  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) {
    return [{ ...base, reason: "no package.json to resolve the script against", unmet: ["package.json"] }];
  }
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [{ ...base, reason: "package.json could not be parsed", unmet: ["a readable package.json"] }];
  }

  const body = scripts[scriptName];
  if (typeof body !== "string") {
    return [{ ...base, reason: `package.json declares no script named "${scriptName}"`, unmet: [`a script named ${scriptName}`] }];
  }

  const bodyEvidence: EvidenceRef = { file: "package.json", text: `${scriptName}: ${body}` };

  if (OPAQUE_WRAPPERS.test(body.trim())) {
    // The jest-dom case. `npm run validate` -> `kcd-scripts validate`: real, but its behaviour is inside
    // a dependency, not this repository. Claiming to understand the pipeline here would be false.
    return [
      {
        ...base,
        resolution: "UNRESOLVABLE",
        reason: `resolves to the wrapper \`${body.trim().split(/\s+/)[0]}\`, whose behaviour is not defined in this repository`,
        evidence: [evidence, bodyEvidence],
        unmet: ["the wrapper's own definition of what it executes"],
      },
    ];
  }

  // A script that invokes further scripts: follow each.
  const nested: ReferenceNode[] = [];
  for (const m of body.matchAll(/\b(?:npm run|yarn(?: run)?|pnpm(?: run)?)\s+([A-Za-z0-9:_-]+)/g)) {
    nested.push(...resolveScript(repoPath, m[1]!, bodyEvidence, seen));
  }

  const expressions = expressionReferences(body, bodyEvidence);
  const blockers = [...nested, ...expressions].filter((n) => n.resolution !== "RESOLVED");

  return [
    {
      ...base,
      resolution: blockers.length === 0 ? "RESOLVED" : "UNRESOLVED",
      ...(blockers.length > 0 ? { reason: `depends on ${blockers.length} unresolved reference(s)` } : {}),
      evidence: [evidence, bodyEvidence],
      dependsOn: [...nested, ...expressions].map((n) => n.id),
      unmet: blockers.flatMap((n) => n.unmet),
    },
    ...nested,
    ...expressions,
  ];
}

/** `uses:` steps become action nodes; only repository-local ones can be resolved. */
export function resolveAction(repoPath: string, uses: string, evidence: EvidenceRef): ReferenceNode {
  const local = uses.startsWith("./");
  if (!local) {
    return {
      id: nextId("action"),
      kind: "COMPOSITE_ACTION",
      identifier: uses,
      resolution: "UNRESOLVABLE",
      reason: "a third-party action; its steps are not in this repository and are not fetched",
      evidence: [evidence],
      dependsOn: [],
      unmet: ["the action's own step definitions"],
    };
  }
  const candidates = [join(repoPath, uses, "action.yml"), join(repoPath, uses, "action.yaml")];
  const found = candidates.find((c) => existsSync(c));
  return {
    id: nextId("action"),
    kind: "LOCAL_ACTION",
    identifier: uses,
    resolution: found ? "RESOLVED" : "UNRESOLVED",
    ...(found ? {} : { reason: "a local action whose action.yml was not found" }),
    evidence: [evidence],
    dependsOn: [],
    unmet: found ? [] : ["the local action definition"],
  };
}

/** `services:` on a job: the step expects something listening that a faithful run must provide. */
export function serviceReferences(facts: ObservedFact[], job: string | undefined): ReferenceNode[] {
  return facts
    .filter((f) => f.kind === "workflow.services" && (!job || `${f.attributes?.workflow}#${f.attributes?.job}` === job))
    .map((f) => ({
      id: nextId("service"),
      kind: "SERVICE" as const,
      identifier: f.value,
      resolution: "UNRESOLVED" as const,
      reason: "the job declares services that a faithful execution must start",
      evidence: [f.evidence],
      dependsOn: [],
      unmet: ["running service containers"],
    }));
}

/** Whether the repository pins a dependency basis — the thing whose absence makes install irreproducible. */
export function pinnedDependencyBasis(facts: ObservedFact[]): { pinned: boolean; evidence?: EvidenceRef; detail: string } {
  const lock = facts.find((f) => f.kind === "lockfile.present");
  if (lock) return { pinned: true, evidence: lock.evidence, detail: `lockfile ${lock.value}` };
  const pm = facts.find((f) => f.kind === "package.packageManager");
  if (pm) return { pinned: true, evidence: pm.evidence, detail: `packageManager ${pm.value}` };
  return { pinned: false, detail: "no lockfile and no packageManager field" };
}

/**
 * ENGINE_COVERAGE_01 item 1. A SEPARATE, WEAKER basis than `pinnedDependencyBasis` — never a silent
 * substitute for it. Established only when an independently-sourced historical cutoff (the pinned
 * commit's own CI run start time, hand-transcribed into the reference plan's `ciGroundTruth.jobStartedAt`
 * — never "now", never derived from a successful install) is available, letting `npm install
 * --before=<cutoff>` bound resolution to versions that existed at that moment. This answers "is there a
 * defensible basis to ATTEMPT the operation", not "does this reconstruct exactly what CI installed" —
 * see docs/engine-coverage-01-item-1-implementation-plan.md for the full reasoning and the six required
 * negative cases this function's callers must preserve.
 *
 * npm-only, this phase: extending the same claim to yarn/pnpm/bun would need each one's own equivalent
 * flag verified the way `--before` was verified here, not an assumption that the shape carries over.
 */
export function timeBoxedDependencyBasis(
  facts: ObservedFact[],
  cutoff: string | undefined,
): { established: boolean; cutoff?: string; detail: string } {
  if (!cutoff) return { established: false, detail: "no independently-sourced historical cutoff supplied" };
  if (Number.isNaN(Date.parse(cutoff))) return { established: false, detail: `cutoff "${cutoff}" is not a valid ISO-8601 timestamp` };
  const pm = facts.find((f) => f.kind === "package.packageManager");
  if (pm) {
    const manager = String(pm.value).split("@")[0]?.toLowerCase();
    if (manager !== "npm") {
      return { established: false, detail: `time-boxed resolution is implemented for npm only in this phase; declared packageManager is "${pm.value}"` };
    }
  }
  return { established: true, cutoff, detail: `install bounded to versions published on or before ${cutoff} (npm --before)` };
}
