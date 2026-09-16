// SPDX-License-Identifier: AGPL-3.0-only
/**
 * WHY an outcome depends on an operation — not merely that one step follows another.
 *
 * `dependsOn` recorded ordering. Ordering cannot answer the question a plan actually needs: *what must
 * be true for TEST to mean anything?* A test run against an uninstalled tree, or against a tree missing
 * compiled output another job produced, is not that outcome — it is the same command producing a
 * different fact.
 *
 * The property this exists to give the graph:
 *
 *   **"TEST exists, but DiffCI cannot establish its complete causal prerequisites"**
 *   must stay distinguishable from
 *   **"TEST does not exist."**
 *
 * The sample produced both, and the engine could express neither: jest's real test command sits inside a
 * third-party action's inputs, and babel's suite consumes an artifact built by a different job. In each
 * case the honest statement is "the outcome is there and its causes are not established", and in each
 * case the engine instead planned something else with confidence.
 *
 * Deliberately NOT a GitHub Actions implementation. Unknown causes are represented as **unresolved
 * edges**, so later capabilities — action inputs, artifacts, reusable workflows, local actions — fill
 * holes in this graph rather than requiring a different one. A model layered on top later should learn
 * probability, cost and necessity **over** these edges, not have to rebuild them.
 */
import type { InferredOperation } from "./schema.js";

export type CausalRelation =
  /** An install operation supplies the dependency tree a later operation runs against. */
  | "PROVIDES_DEPENDENCIES"
  /** A build operation supplies compiled state a later operation runs against. */
  | "PROVIDES_BUILT_STATE"
  /** A job produces a named artifact. */
  | "PRODUCES_ARTIFACT"
  /** An operation requires a named artifact produced elsewhere. */
  | "CONSUMES_ARTIFACT"
  /** An action's inputs supply the command it will execute. */
  | "SUPPLIES_INPUT"
  /** A third-party action executes a command on the pipeline's behalf. */
  | "EXECUTES";

export type EdgeResolution = "RESOLVED" | "UNRESOLVED";

export interface CausalNode {
  id: string;
  kind: "OPERATION" | "ARTIFACT" | "ACTION_EXECUTION";
  label: string;
}

export interface CausalEdge {
  from: string;
  to: string;
  relation: CausalRelation;
  resolution: EdgeResolution;
  /** Present on every UNRESOLVED edge: what could not be established, in the receipt's own words. */
  reason?: string;
}

export interface CausalPath {
  outcome: string;
  /** True when an operation with this purpose exists AT ALL — the distinction that matters most. */
  outcomePresent: boolean;
  /** The operation that provides the outcome, when one does. */
  targetId?: string;
  nodes: CausalNode[];
  edges: CausalEdge[];
  /** Edges on the required path that could not be established. */
  unresolved: CausalEdge[];
  /** True only when the outcome is present AND every required edge is RESOLVED. */
  complete: boolean;
  reason: string;
}

/** A prerequisite the job declares but this engine cannot follow — an artifact, or an action's command. */
export interface DeclaredPrerequisite {
  kind: "ARTIFACT" | "ACTION_EXECUTION";
  /** Artifact name, or the action reference (`owner/repo@sha`). */
  identifier: string;
  /** Why it cannot be followed, recorded verbatim on the resulting unresolved edge. */
  reason: string;
}

/**
 * Whether an operation's own execution is established.
 *
 * An operation whose condition is FALSE is **not** a blocker: the pipeline does not run it in this
 * instance, which is a resolved fact about the path rather than a hole in it. An operation whose
 * condition is UNRESOLVED (`willExecute === undefined`) IS a blocker — see defect 29.
 */
function operationResolved(op: InferredOperation): boolean {
  if (op.willExecute === false) return true;
  return op.executable && op.executionRepresentation !== "UNRESOLVED" && op.willExecute === true;
}

function activelyRuns(op: InferredOperation): boolean {
  return op.willExecute !== false;
}

/**
 * Builds the causal path for one outcome within one job's operations.
 *
 * `prerequisites` carries what the job declares but this engine cannot follow. They become UNRESOLVED
 * edges into the outcome, which is how "we know something is missing and cannot say what it contains"
 * gets represented instead of being silently absent.
 */
export function causalPathFor(
  operations: InferredOperation[],
  outcome: string,
  prerequisites: DeclaredPrerequisite[] = [],
  /**
   * How to NAME the outcome in messages.
   *
   * Matching happens on `OperationKind` (`test`) while callers speak in `Purpose` (`TEST`). This
   * codebase keeps those vocabularies deliberately distinct, and a refusal that mixed them would blur
   * the very distinction the uppercase/lowercase split exists to hold.
   */
  label: string = outcome,
): CausalPath {
  const nodes: CausalNode[] = [];
  const edges: CausalEdge[] = [];

  const target = [...operations].reverse().find((o) => o.kind === outcome && activelyRuns(o));
  if (!target) {
    return {
      outcome,
      outcomePresent: false,
      nodes,
      edges,
      unresolved: [],
      complete: false,
      reason: `no operation in this job provides ${label}`,
    };
  }

  nodes.push({ id: target.id, kind: "OPERATION", label: target.command.join(" ") || target.id });

  const indexOfTarget = operations.indexOf(target);
  const before = operations.slice(0, indexOfTarget);

  const addOperationEdge = (op: InferredOperation, relation: CausalRelation): void => {
    nodes.push({ id: op.id, kind: "OPERATION", label: op.command.join(" ") || op.id });
    const resolved = operationResolved(op);
    edges.push({
      from: op.id,
      to: target.id,
      relation,
      resolution: resolved ? "RESOLVED" : "UNRESOLVED",
      ...(resolved
        ? {}
        : {
            reason:
              op.willExecute === undefined
                ? "this prerequisite's condition could not be evaluated, so whether it runs is unknown"
                : op.executionRepresentation === "UNRESOLVED"
                  ? "this prerequisite's command cannot be represented for execution"
                  : `this prerequisite is not executable: ${[...op.missingRequirements, ...op.blockedBy].join(", ") || "cause not recorded"}`,
          }),
    });
  };

  // INSTALL → TEST, BUILD → TEST. Only required when the job HAS such an operation: a repository that
  // needs no install is not missing one, and inventing the requirement would refuse a sound pipeline.
  for (const relation of ["install", "build"] as const) {
    const provider = [...before].reverse().find((o) => o.kind === relation && activelyRuns(o));
    if (provider) addOperationEdge(provider, relation === "install" ? "PROVIDES_DEPENDENCIES" : "PROVIDES_BUILT_STATE");
  }

  // Declared-but-unfollowable prerequisites. These are the sample's two capability gaps, represented
  // rather than implemented.
  for (const [i, prereq] of prerequisites.entries()) {
    const id = `${prereq.kind.toLowerCase()}-${i}-${prereq.identifier}`;
    nodes.push({ id, kind: prereq.kind, label: prereq.identifier });
    edges.push({
      from: id,
      to: target.id,
      relation: prereq.kind === "ARTIFACT" ? "CONSUMES_ARTIFACT" : "EXECUTES",
      resolution: "UNRESOLVED",
      reason: prereq.reason,
    });
  }

  const unresolved = edges.filter((e) => e.resolution === "UNRESOLVED");
  const targetResolved = operationResolved(target);
  if (!targetResolved) {
    unresolved.push({
      from: target.id,
      to: target.id,
      relation: "EXECUTES",
      resolution: "UNRESOLVED",
      reason:
        target.executionRepresentation === "UNRESOLVED"
          ? "the outcome's own command cannot be represented for execution"
          : `the outcome's own operation is not executable: ${[...target.missingRequirements, ...target.blockedBy].join(", ") || "cause not recorded"}`,
    });
  }

  const complete = unresolved.length === 0;
  return {
    outcome,
    outcomePresent: true,
    targetId: target.id,
    nodes,
    edges,
    unresolved,
    complete,
    reason: complete
      ? `${label} is provided by ${target.id} and every required cause is established`
      : `${label} EXISTS but ${unresolved.length} causal prerequisite(s) could not be established: ${unresolved
          .map((e) => `${e.from} (${e.reason})`)
          .join("; ")}`,
  };
}
