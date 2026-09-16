// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The reference graph — what an execution step DEPENDS ON in order to be reproducible.
 *
 * INFERENCE_01 stored unresolved things as strings and assigned confidence by hand. That let an
 * operation be labelled `OBSERVED` because a plausible command was seen, while the things the command
 * actually needs — a pinned package manager, a resolvable script, an expanded matrix, a running service
 * — were unknown. `eslint-plugin-vue` produced a confident `npm install` that was equivalent to the
 * generic derivation that had already failed.
 *
 * So references become NODES. Each carries its evidence, its resolution state and what it still needs,
 * and **confidence is computed from the graph** rather than chosen:
 *
 *   every reference RESOLVED            → the operation may be executed
 *   any reference UNRESOLVED/UNRESOLVABLE → the operation is reportable but NOT executable
 *
 * THE HARD BOUNDARY:
 *
 *     incomplete causal execution path  ⇒  REFUSE TO OPTIMISE
 *
 * The engine may still say what it believes the command probably is. A decision engine must not treat
 * that belief as an executable plan.
 */
import type { EvidenceRef } from "./schema.js";

export type ReferenceKind =
  /** `uses: ./.github/actions/x` — lives in the repository and can be read. */
  | "LOCAL_ACTION"
  /** `uses: owner/repo@ref` — a third-party action whose steps are not in this repository. */
  | "COMPOSITE_ACTION"
  /** `jobs.x.uses: ./.github/workflows/y.yml` — another workflow supplying the steps. */
  | "REUSABLE_WORKFLOW"
  /** `${{ matrix.* }}` — the concrete command depends on an expansion. */
  | "MATRIX_EXPANSION"
  /** `services:` — the step expects something listening that the graph must provide. */
  | "SERVICE"
  /** `npm run x` — resolves through package.json, possibly to another script or an opaque binary. */
  | "SCRIPT_REFERENCE"
  /** `${{ secrets.X }}`, `$VAR` — a value not present in the repository. */
  | "ENV_REFERENCE"
  /** The command itself, once everything above is settled. */
  | "EXECUTION_OPERATION";

export type Resolution =
  /** Fully known from repository evidence. */
  | "RESOLVED"
  /** Not known yet, and knowable in principle — a local file not read, a script not followed. */
  | "UNRESOLVED"
  /** Not knowable from repository evidence alone — a remote action, a secret, a runner resource. */
  | "UNRESOLVABLE";

export interface ReferenceNode {
  id: string;
  kind: ReferenceKind;
  /** What is referenced, verbatim: an action name, a script name, a variable. */
  identifier: string;
  resolution: Resolution;
  /** Why it is not RESOLVED. Absent when it is. */
  reason?: string;
  evidence: EvidenceRef[];
  /** Other node ids this one needs. */
  dependsOn: string[];
  /** Requirements this node knows it has not met. */
  unmet: string[];
}

/**
 * What an operation of each kind needs before it can be executed FAITHFULLY.
 *
 * Not a checklist for its own sake: every entry is a thing whose absence has produced, or could
 * produce, a run that looks like the repository's CI and is not.
 */
export const REQUIREMENT_PREDICATES = {
  COMMAND_RESOLVED: {
    label: "a resolved command",
    predicate: "the operation has a non-empty argv",
  },
  WORKING_DIRECTORY_KNOWN: {
    label: "a known working directory",
    predicate: "the operation runs at a directory this engine can name",
  },
  SCRIPTS_RESOLVED: {
    label: "all referenced scripts resolved",
    predicate: "every SCRIPT_REFERENCE this operation depends on resolved to a body",
  },
  DEPENDENCY_BASIS_PINNED: {
    label: "a pinned dependency basis (lockfile or packageManager field)",
    predicate: "the repository commits a lockfile or declares a packageManager field",
  },
  /** ENGINE_COVERAGE_01 item 1. A distinct, WEAKER claim than DEPENDENCY_BASIS_PINNED — never merged
   *  into it. Satisfying this means "a defensible historical basis to ATTEMPT the operation", not "the
   *  exact dependency graph CI originally installed was reconstructed". See
   *  docs/engine-coverage-01-item-1-implementation-plan.md. */
  DEPENDENCY_BASIS_TIME_BOXED: {
    label: "a defensible time-boxed dependency basis (no committed lock, resolution bounded to the repository's own historical CI run)",
    predicate: "an independently-sourced historical cutoff exists and the install path can be bounded to it (npm only)",
  },
} as const;

export type RequirementId = keyof typeof REQUIREMENT_PREDICATES;

/** A single mandatory requirement, or a group where satisfying ANY ONE member satisfies the whole slot —
 *  used for DEPENDENCY_BASIS_PINNED / DEPENDENCY_BASIS_TIME_BOXED, which are alternative, not additive,
 *  bases for the same install operation. */
export type RequirementSlot = RequirementId | readonly RequirementId[];

/**
 * One requirement, its predicate, and what was actually seen.
 *
 * DEFECT 30. The requirement named "a resolved package manager" was implemented as
 * `command.length > 0`. The label said package manager; the code tested whether the command was empty.
 * webpack's refusal cited it against a repository that pins `yarn@1.22.22` WITH a committed lockfile,
 * so the receipt asserted evidence the engine had never established — and a maintainer acting on it
 * would have hunted a problem that did not exist. That is an evidence-integrity defect, not wording.
 *
 * The shape is the fix: `predicate` states what the code tests and `observed` states what it saw, so a
 * label divorced from its implementation has nowhere to hide. The bogus requirement is DELETED rather
 * than renamed — it duplicated COMMAND_RESOLVED while claiming to check something else.
 *
 * Receipts explain WHY a verdict was reached. They are never a source the verdict is derived from.
 */
export interface RequirementCheck {
  id: RequirementId;
  label: string;
  predicate: string;
  /** What the engine saw, in its own words — the half a boolean cannot carry. */
  observed: string;
  satisfied: boolean;
}

export const COMPLETENESS_REQUIREMENTS: Record<string, RequirementSlot[]> = {
  install: [
    // Without one, "install" is not reproducible: the same command resolves differently over time,
    // which is exactly how eslint-plugin-vue's generic `npm install` crashed — and what member 5 of
    // CI_REPRODUCTION_SAMPLE_01 demonstrated empirically, its CI passing on 2026-08-04 and its suite
    // failing today because `webpack@5` resolved to a version published 28 days later.
    //
    // ENGINE_COVERAGE_01 item 1: an OR-slot, not two additive requirements. DEPENDENCY_BASIS_PINNED is
    // tried first (genuine lockfile/packageManager pinning); DEPENDENCY_BASIS_TIME_BOXED is only
    // evaluated - and only then shown in a receipt at all - when PINNED already failed. A repository
    // that already pins its dependencies never gains a TIME_BOXED entry in its checks; only eslint/chalk
    // (no lockfile, no packageManager) reach the second alternative.
    ["DEPENDENCY_BASIS_PINNED", "DEPENDENCY_BASIS_TIME_BOXED"],
    "COMMAND_RESOLVED",
    "WORKING_DIRECTORY_KNOWN",
  ],
  test: ["COMMAND_RESOLVED", "WORKING_DIRECTORY_KNOWN", "SCRIPTS_RESOLVED"],
  build: ["COMMAND_RESOLVED", "WORKING_DIRECTORY_KNOWN", "SCRIPTS_RESOLVED"],
  default: ["COMMAND_RESOLVED", "WORKING_DIRECTORY_KNOWN"],
};

export interface Completeness {
  /** Every requirement with its predicate and what was observed — the receipt's evidence. */
  checks: RequirementCheck[];
  /** Requirements met, by name. */
  satisfied: string[];
  /** Requirements NOT met, by name. Non-empty means not executable. */
  missing: string[];
  /** Reference nodes blocking this operation. */
  blockedBy: ReferenceNode[];
  /** Derived, never assigned: complete AND every reference resolved. */
  executable: boolean;
}

/**
 * Computes completeness for one operation from its reference nodes.
 *
 * `executable` is the only thing a decision engine may act on. `missing` and `blockedBy` are what a
 * human — or a future model — reads to understand WHY, which a boolean cannot carry.
 */
export function computeCompleteness(
  kind: string,
  observations: Partial<Record<RequirementId, { satisfied: boolean; observed: string }>>,
  references: ReferenceNode[],
): Completeness {
  const required = COMPLETENESS_REQUIREMENTS[kind] ?? COMPLETENESS_REQUIREMENTS.default!;
  const checks: RequirementCheck[] = [];
  const unmetLabels: string[] = [];
  for (const slot of required) {
    // A plain id is a mandatory requirement (a one-member slot). An array is an OR-group: satisfying ANY
    // member satisfies the whole slot. Members are evaluated IN ORDER and evaluation stops at the first
    // satisfied one - a later alternative is never even computed, let alone shown in a receipt, once an
    // earlier one already held. This is what keeps every already-pinned repository's checks byte-for-byte
    // unchanged: DEPENDENCY_BASIS_TIME_BOXED is never looked up when DEPENDENCY_BASIS_PINNED is true.
    const ids: readonly RequirementId[] = Array.isArray(slot) ? slot : [slot];
    const slotChecks: RequirementCheck[] = [];
    let slotSatisfied = false;
    for (const id of ids) {
      if (slotSatisfied) break;
      const spec = REQUIREMENT_PREDICATES[id];
      const seen = observations[id];
      const satisfied = seen?.satisfied === true;
      slotChecks.push({ id, label: spec.label, predicate: spec.predicate, observed: seen?.observed ?? "not observed", satisfied });
      if (satisfied) slotSatisfied = true;
    }
    checks.push(...slotChecks);
    if (!slotSatisfied) unmetLabels.push(...slotChecks.map((c) => c.label));
  }
  const blockedBy = references.filter((n) => n.resolution !== "RESOLVED");
  return {
    checks,
    satisfied: checks.filter((c) => c.satisfied).map((c) => c.label),
    missing: unmetLabels,
    blockedBy,
    executable: unmetLabels.length === 0 && blockedBy.length === 0,
  };
}

/**
 * Confidence DERIVED from completeness. Never hand-assigned.
 *
 * `OBSERVED` now means more than "we saw this text": the command was seen AND everything it depends on
 * is resolved. That is the distinction INFERENCE_01 could not express, and it is why a plausible-looking
 * command could be labelled with the highest confidence available.
 */
export function confidenceFromCompleteness(sawVerbatim: boolean, completeness: Completeness): "OBSERVED" | "DERIVED" | "ASSUMED" {
  if (sawVerbatim && completeness.executable) return "OBSERVED";
  if (sawVerbatim || completeness.missing.length < (COMPLETENESS_REQUIREMENTS.default?.length ?? 2)) return "DERIVED";
  return "ASSUMED";
}
