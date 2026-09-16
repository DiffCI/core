// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CI configuration inference — the evidence and learning schema.
 *
 * THE ONE INVARIANT THIS FILE EXISTS FOR: an OBSERVED FACT and an INFERENCE drawn from it are different
 * kinds of thing and are never stored in the same shape.
 *
 * A workflow line saying `npm ci` is a fact — it is in the file, at a path, at a line. "npm ci is this
 * repository's canonical install command" is an inference, derived from that fact by a named rule, and it
 * can be wrong while the fact stays true. Generation C's whole defect history is the cost of blurring
 * that: a derived command was recorded as though it were the repository's own, and when it failed the
 * failure was nearly attributed to the repository.
 *
 * This matters most for the training substrate. A model trained on rows where "what we saw" and "what we
 * concluded" are indistinguishable learns to reproduce our conclusions, including our mistakes, with no
 * way to re-derive them from evidence. Retrofitting the distinction later is impossible — the evidence is
 * gone by then.
 *
 * THE REPRESENTATION IS AN EXECUTION GRAPH, NOT A COMMAND LIST. Even where V1 understands only
 * install/build/test, the shape must grow into:
 *
 *   checkout → install → generate → lint → typecheck → build → test → security → package → deploy → verify
 *
 * A command list would have to be torn apart to get there, and every consumer rewritten with it.
 */

import type { InferredJob } from "./jobs.js";
import type { ReferenceNode } from "./reference-graph.js";

/** Where a fact was observed. A fact without a location cannot be re-checked. */
export interface EvidenceRef {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line, when the fact came from a line rather than a whole file. */
  line?: number;
  /** The literal text observed, trimmed. Never a paraphrase. */
  text: string;
}

/**
 * Something READ from the repository. Not a conclusion.
 *
 * `kind` names what was read, not what it means: `workflow.step.run` is a fact about a YAML file;
 * whether that step is the canonical install is an inference.
 */
export interface ObservedFact {
  kind:
    | "workflow.job"
    | "workflow.step.run"
    | "workflow.step.uses"
    /** A `with:` input of a `uses:` step. Recorded, never interpreted here - see evidence.ts. */
    | "workflow.step.with"
    | "workflow.matrix"
    | "workflow.env"
    | "workflow.services"
    | "package.script"
    | "package.packageManager"
    | "package.engines"
    | "package.dependency"
    | "lockfile.present"
    | "nodeVersionFile"
    | "runnerConfig";
  value: string;
  evidence: EvidenceRef;
  /** Free-form detail that stays DATA — e.g. the job id a step belongs to. */
  attributes?: Record<string, string>;
}

/** The operations a pipeline can contain. Deliberately wider than V1 understands. */
export type OperationKind =
  | "checkout"
  | "setup-runtime"
  | "install"
  | "generate"
  | "lint"
  | "typecheck"
  | "build"
  | "test"
  | "security"
  | "package"
  | "deploy"
  | "verify"
  | "unknown";

/**
 * How much the inference engine trusts one inferred operation.
 *
 * `OBSERVED` is reserved for an operation lifted VERBATIM from a workflow the repository runs in CI —
 * the strongest evidence available without executing anything. `DERIVED` means a rule produced it from
 * facts. `ASSUMED` means a default filled a gap, and is the level at which Generation C's failures all
 * happened.
 */
export type Confidence = "OBSERVED" | "DERIVED" | "ASSUMED";

/** Something the engine could not resolve. Kept, never silently dropped. */
export interface Unresolved {
  what: string;
  why: string;
  evidence?: EvidenceRef;
}

/**
 * One node of the execution graph.
 *
 * `evidence` is the list of facts this operation was inferred FROM, so a reader can re-derive the
 * conclusion rather than trust it. An operation with `confidence: "OBSERVED"` and an empty evidence list
 * is a contradiction, and `validateOperation` rejects it.
 */
export interface InferredOperation {
  id: string;
  kind: OperationKind;
  /** argv, never a shell string, so it cannot be re-split differently later. */
  command: string[];
  workingDirectory: string;
  /** Runtime the step needs, when the repository declares one. */
  runtime?: { name: "node" | "other"; version?: string; source: EvidenceRef };
  /** Environment the repository sets for this operation. */
  environment: Record<string, string>;
  /** Operation ids that must complete first. */
  dependsOn: string[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  unresolved: Unresolved[];
  /** Present ONLY when the engine declines to propose this operation. */
  refusalReason?: string;
  /**
   * The step condition and how it evaluated for this matrix instance.
   *
   * A step whose condition is FALSE is NOT removed: it is recorded as
   * declared: true -> condition: FALSE -> executed: false. Deleting it would make a skipped step
   * indistinguishable from a step the pipeline never had — unknown versus absent, again.
   */
  condition?: { expression: string; result: "TRUE" | "FALSE" | "UNRESOLVED"; reason?: string };
  /**
   * Whether this operation runs in this instance. THREE-VALUED, deliberately.
   *
   * `true` when the condition is TRUE or absent, `false` only when it is FALSE, and **`undefined` when
   * it is UNRESOLVED** — we could not read the condition, which is not the same as knowing the step is
   * skipped.
   *
   * DEFECT 29. This was `condition.result === "TRUE"`, collapsing UNRESOLVED into false. `expression.ts`
   * had documented that UNRESOLVED is not FALSE, and the consumer one file away narrowed three values to
   * two — an invariant stated in one file and violated in the next. On jest that turned an unreadable
   * `github.event.*` condition into "this step does not run", which let a path of entirely non-running
   * steps be reported executable.
   */
  willExecute?: boolean;
  /**
   * SEMANTIC PURPOSE, independent of whether the command can be executed.
   *
   * The four states must stay distinguishable:
   *
   *   purpose TEST    + execution RESOLVED     the normal case
   *   purpose TEST    + execution UNRESOLVED   webpack: a compound line we cannot safely run, that the
   *                                            repository nonetheless says is its test step
   *   purpose NONE    + execution RESOLVED     a runnable command we cannot attribute an outcome to
   *   purpose UNKNOWN + execution UNRESOLVED   nothing established either way
   *
   * Executor limitations must not erase pipeline semantics.
   */
  executionRepresentation?: "RESOLVED" | "UNRESOLVED";
  /**
   * HOW the purpose was established — EXECUTABLE_POSITION, SCRIPT_BODY, SCRIPT_NAME or NONE.
   *
   * Kept on every operation and carried into receipts: "we recognised the runner being invoked" and
   * "we matched a conventional script name" are different strengths of claim, and a learning system
   * later needs the evidence rather than only the label.
   */
  purposeBasis?: string;
  /**
   * Every requirement with its predicate and what was observed.
   *
   * Receipts EXPLAIN why the planner reached a verdict; they are never a source the verdict is derived
   * from. Carrying the observation alongside the predicate is what stopped defect 30 being writable.
   */
  requirementChecks?: Array<{ id: string; label: string; predicate: string; observed: string; satisfied: boolean }>;
  /** How each expression in the command resolved, so an empty value can be traced to its cause. */
  expressionResolutions?: Array<{ expression: string; kind: string; value: string; reason?: string }>;
  /**
   * Whether a decision engine may EXECUTE this operation, derived from reference-graph completeness.
   *
   * INFERENCE_02. An operation can be reportable and not executable: the engine may state what it
   * believes the command probably is while refusing to treat that belief as a plan. Those are different
   * claims and INFERENCE_01 could not tell them apart.
   */
  executable: boolean;
  /** Requirements this operation has not met. Non-empty implies executable === false. */
  missingRequirements: string[];
  /** Reference-node ids blocking execution. */
  blockedBy: string[];
}

/**
 * The inferred pipeline for one repository at one tree.
 *
 * `facts` is everything observed; `operations` is everything concluded. The separation is the point.
 */
export interface InferredPipeline {
  schema: "diffci.ci.inference/v1";
  repository: string;
  headSha: string;
  facts: ObservedFact[];
  /**
   * EVERY workflow job, kept whole, with the purposes each provides.
   *
   * INFERENCE_03. The previous version collapsed a workflow to one job and lost the rest; lint and
   * security disappeared from html-webpack-plugin because the test job won a scoring function. A
   * pipeline has several purposes and optimising all of it eventually needs all of them.
   */
  jobs: InferredJob[];
  /** Every operation across every job, flattened. */
  operations: InferredOperation[];
  unresolved: Unresolved[];
  /** The reference graph behind the operations - what each step depends on and whether it resolved. */
  references: ReferenceNode[];
  /**
   * THE HARD BOUNDARY: an incomplete causal execution path means the pipeline must not be optimised.
   *
   * True when every operation is executable. False is not a failure - it is the engine declining to let
   * a decision engine act on an incomplete understanding.
   */
  optimisable: boolean;
  /** Why optimisation is refused, when it is. */
  optimisationRefusal?: string;
  /**
   * The engine declines to describe this pipeline at all.
   *
   * A refusal is a RESULT, not a failure: an optimiser that cannot tell when it does not understand a
   * pipeline is more dangerous than one that says so.
   */
  refusal?: { reason: string; evidence: EvidenceRef[] };
  producedAt: string;
}

/**
 * One benchmark row: the old generic derivation, the new inference, and what actually happened.
 *
 * This is the training row shape. It is written even when the inference refuses, because a refusal that
 * would have prevented a known failure is a correct outcome and must be learnable as one.
 */
export interface InferenceBenchmarkRow {
  schema: "diffci.ci.inference.benchmark/v1";
  repository: string;
  headSha: string;
  /** What E2 registration derived generically, and what it produced. */
  genericDerivation: { install: string[]; build?: string[]; testModule?: string; testArgs?: string[] };
  knownFailure: { stage: string; detail: string };
  /** What the inference engine says, from repository evidence alone. */
  inferred: InferredPipeline;
  /** Whether the inference would have avoided the known failure — see `BenchmarkVerdict`. */
  verdict: BenchmarkVerdict;
  verdictReason: string;
}

/**
 * How an inference is scored against a known failure.
 *
 * CORRECT_REFUSAL is scored as a SUCCESS. The engine must know when it does not understand a pipeline
 * well enough to optimise it, and saying so is more valuable than a confident wrong plan.
 */
export type BenchmarkVerdict =
  /** The inferred plan differs from the generic one in the way that would have avoided the failure. */
  | "CORRECT_INFERENCE"
  /** The engine refused, and the refusal would have prevented the failure. */
  | "CORRECT_REFUSAL"
  /** The engine could not resolve enough to say anything, and says so. Not a wrong answer. */
  | "INSUFFICIENT_EVIDENCE"
  /** The engine produced a confident plan that would still have failed, or failed differently. */
  | "INCORRECT_INFERENCE";

/** Structural checks that must hold for any operation the engine emits. */
export function validateOperation(op: InferredOperation): string[] {
  const problems: string[] = [];
  if (op.confidence === "OBSERVED" && op.evidence.length === 0) {
    problems.push(`${op.id}: OBSERVED confidence with no evidence - a conclusion presented as an observation`);
  }
  if (op.command.length === 0 && !op.refusalReason) {
    problems.push(`${op.id}: empty command with no refusal reason`);
  }
  if (op.refusalReason && op.command.length > 0) {
    problems.push(`${op.id}: refused but still proposes a command`);
  }
  return problems;
}
