// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Job semantics — what each workflow job is FOR, and a planner that resolves a path to an outcome.
 *
 * WHY THIS REPLACES `primaryJob`. INFERENCE_02 collapsed a workflow to a single job by scoring jobs on
 * how many recognised operations they ran. On `html-webpack-plugin` the lint job (lint + security) beat
 * the build job (test:coverage) two-to-one, so the engine described the lint pipeline and proposed no
 * test step at all — then claimed the pipeline was executable. `lint-staged` failed the same way.
 *
 * The defect was never the scoring weights. It was collapsing a workflow to one job at all: a pipeline
 * has several purposes, and "which job wins" is the wrong question. The right one is **which path
 * produces the outcome being asked about**.
 *
 * So every job is preserved as a node with the purposes it provides, and a planner resolves a path for
 * a requested purpose. Nothing is discarded because it lost a comparison — `lint` and `security` remain
 * in the graph, because optimising the WHOLE pipeline eventually needs them.
 *
 * This is deliberately not "prefer jobs containing test". A purpose is derived from the operations a job
 * actually contains; asking for `TEST` finds jobs that provide `TEST`, and asking for `LINT` finds jobs
 * that provide `LINT`, with the same code.
 */
import { causalPathFor, type CausalPath, type DeclaredPrerequisite } from "./causal.js";
import type { InferredOperation, OperationKind } from "./schema.js";

/** What a job or operation is FOR. Uppercase to keep it distinct from the operation-kind vocabulary. */
export type Purpose = "INSTALL" | "BUILD" | "LINT" | "TYPECHECK" | "TEST" | "SECURITY" | "PACKAGE" | "DEPLOY" | "GENERATE" | "VERIFY" | "UNKNOWN";

const PURPOSE_BY_KIND: Partial<Record<OperationKind, Purpose>> = {
  install: "INSTALL",
  build: "BUILD",
  lint: "LINT",
  typecheck: "TYPECHECK",
  test: "TEST",
  security: "SECURITY",
  package: "PACKAGE",
  deploy: "DEPLOY",
  generate: "GENERATE",
  verify: "VERIFY",
};

export function purposeOfKind(kind: OperationKind): Purpose {
  return PURPOSE_BY_KIND[kind] ?? "UNKNOWN";
}

/**
 * One workflow job, kept whole.
 *
 * `provides` is derived from the operations it contains — never from its name. A job called "test" that
 * runs only a linter provides `LINT`, and a job called "ci" that runs a suite provides `TEST`.
 */
export interface InferredJob {
  id: string;
  workflow: string;
  job: string;
  /** The concrete matrix cell this instance represents, when the job declares a matrix. */
  matrix?: Record<string, string>;
  /** Index of this instance in declaration order, so a receipt can name WHICH cell it reproduced. */
  matrixInstance?: number;
  provides: Purpose[];
  operations: InferredOperation[];
  /**
   * Causal prerequisites the job declares that this engine cannot follow.
   *
   * Carried on the job rather than derived in the planner, so the planner CONSUMES causal evidence and
   * never manufactures it from action names or classifications.
   */
  prerequisites?: DeclaredPrerequisite[];
  /** Reference-node ids that block this job as a whole. */
  blockedBy: string[];
}

export function jobProvides(operations: InferredOperation[]): Purpose[] {
  const seen = new Set<Purpose>();
  for (const op of operations) {
    const purpose = purposeOfKind(op.kind);
    if (purpose !== "UNKNOWN") seen.add(purpose);
  }
  return [...seen].sort();
}

export interface PurposePlan {
  purpose: Purpose;
  /** The job chosen to produce this outcome, if any provides it. */
  jobId?: string;
  /** Operations to execute, in dependency order, including the prerequisites the outcome needs. */
  operations: InferredOperation[];
  /** True only when every operation in the path is executable. */
  executable: boolean;
  /** Why the path cannot be executed, when it cannot. */
  refusal?: string;
  /** The causal path consulted, so a receipt can show WHY rather than assert a verdict. */
  causal?: CausalPath;
}

/**
 * Resolves the execution path for one requested outcome.
 *
 * Deterministic: among jobs that provide the purpose, the one with the fewest blocked operations wins;
 * workflow-then-job order breaks ties. Preferring the least-blocked job is not a quality judgement about
 * the repository — it is choosing the path this engine can actually account for.
 *
 * `INSTALL` is included as a prerequisite whenever the chosen job has one, because a test outcome
 * produced from an uninstalled tree is not that outcome.
 */
export function planForPurpose(jobs: InferredJob[], purpose: Purpose): PurposePlan {
  const providers = jobs.filter((j) => j.provides.includes(purpose));
  if (providers.length === 0) {
    return {
      purpose,
      operations: [],
      executable: false,
      refusal: `no workflow job provides ${purpose}; the repository may produce this outcome outside GitHub Actions, or this engine did not recognise the step that does`,
    };
  }

  const blockedCount = (j: InferredJob): number => j.operations.filter((o) => !o.executable).length;
  const chosen = [...providers].sort((a, b) => blockedCount(a) - blockedCount(b))[0]!;

  // The prerequisite chain: install first when the job has one, then everything up to and including the
  // operations that deliver the requested purpose. Steps AFTER it are not needed for this outcome.
  const ordered = chosen.operations;
  const lastIndex = ordered.reduce((acc, op, i) => (purposeOfKind(op.kind) === purpose ? i : acc), -1);
  const path = lastIndex === -1 ? [] : ordered.slice(0, lastIndex + 1);

  // DEFECT 27, implemented as the invariant rather than as a patch for the empty-plan symptom:
  //
  //   Executable(P, OUTCOME)  ⇒  ∃ o ∈ P : Purpose(o) = OUTCOME ∧ Executable(o) ∧ CausallyProvides(o, OUTCOME)
  //
  // That is necessary and NOT sufficient, so all five conditions are required:
  //
  //   1. at least one executable operation CAUSALLY PROVIDES the requested outcome
  //   2. every required causal predecessor is resolved, executable, or structurally known not to run
  //   3. UNRESOLVED anywhere on the required causal path blocks executability
  //   4. a FALSE condition removes that operation from the ACTIVE path while retaining its receipt
  //   5. an empty active path can never satisfy the outcome
  //
  // The old rule asked only whether `blocked` was empty, and a path whose every step will not run has
  // nothing to block — so jest's plan, one operation with `command: []` and `willExecute: false`, was
  // reported EXECUTABLE and then executed nothing.

  // (4) A FALSE condition leaves the operation in `path` — and so in the receipt — but out of the
  // active path. "Skipped" and "never existed" must stay distinguishable.
  const active = path.filter((o) => o.willExecute !== false);

  // (3) UNRESOLVED is not FALSE. `willExecute === undefined` means the condition could not be read, so
  // the operation stays on the required path and blocks it.
  const blocked = active.filter((o) => !o.executable);

  // (1) The outcome must be provided by an operation that can actually run — not merely be present.
  const provider = active.find((o) => purposeOfKind(o.kind) === purpose && o.executable && o.executionRepresentation !== "UNRESOLVED");

  // LAYER 5. The planner CONSUMES the causal path; it does not re-derive one.
  //
  // The prerequisites come from the job, where they were recorded from what the workflow DECLARES. The
  // planner must never manufacture missing causal evidence from command text, action names or purpose
  // classifications — that is the architectural leak these layers exist to close, and it would reappear
  // here first, because this is where a plan is finally allowed to say yes.
  const kindOfPurpose = Object.entries(PURPOSE_BY_KIND).find(([, p]) => p === purpose)?.[0];
  const causal: CausalPath | undefined = kindOfPurpose
    ? causalPathFor(path, kindOfPurpose, chosen.prerequisites ?? [], purpose)
    : undefined;

  // (5) An empty active path can never satisfy the outcome.
  const refusals: string[] = [];
  if (active.length === 0) {
    refusals.push(`every operation in the ${purpose} path is skipped in this instance, so nothing would run`);
  }
  if (blocked.length > 0) {
    refusals.push(
      `${blocked.length} operation(s) in the ${purpose} path are not executable: ${blocked
        .map((o) => `${o.id} (${[...o.missingRequirements, ...o.blockedBy].join(", ") || "cause not recorded"})`)
        .join("; ")}`,
    );
  }
  if (!provider) {
    refusals.push(`no executable operation in this path causally provides ${purpose}; a path containing something CLASSIFIED as ${purpose} is not the same as one that produces it`);
  }

  // (2) Every required causal predecessor must be established. An unresolved edge - an artifact from a
  // job we do not follow, a command inside an action we do not read - blocks the plan while leaving the
  // outcome PRESENT. "TEST exists and we cannot establish its causes" is the honest refusal; planning
  // something else instead is what produced jest's DIVERGED and webpack's INCORRECT_REFUSAL.
  if (causal && causal.outcomePresent && !causal.complete) {
    refusals.push(causal.reason);
  }

  return {
    purpose,
    jobId: chosen.id,
    operations: path,
    executable: refusals.length === 0,
    ...(causal ? { causal } : {}),
    ...(refusals.length > 0 ? { refusal: refusals.join(". ") } : {}),
  };
}
