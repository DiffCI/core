// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Inference — turns observed facts into an execution graph, citing what each conclusion came from.
 *
 * THE RULE THAT ORDERS EVERYTHING: prefer what the repository RUNS in CI over what its manifest
 * declares. A workflow is the project's own executable statement of how it builds and tests itself; a
 * `package.json` script is a convenience that CI may or may not use. Generation C derived from the
 * manifest alone and was wrong on four of six repositories.
 *
 * INFERENCE_03: EVERY JOB IS KEPT. The previous version collapsed a workflow to a single `primaryJob`
 * chosen by how many recognised operations it ran, and on `html-webpack-plugin` that made the lint job
 * beat the build job — so the engine described the lint pipeline, proposed no test step, and still
 * reported the pipeline executable. `lint-staged` failed identically.
 *
 * The fix is not better weights. A workflow has several purposes and "which job wins" is the wrong
 * question; `jobs.ts` asks which path produces a requested outcome instead. `lint` and `security` stay
 * in the graph as nodes, because optimising the whole pipeline will need them.
 *
 * Confidence and executability are DERIVED from reference-graph completeness, never assigned.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { jobProvides, type InferredJob } from "./jobs.js";
import { evaluateCondition, renderCommand, type Resolution } from "./expression.js";
import { expandMatrix, type MatrixAssignment } from "./matrix.js";
import { computeCompleteness, confidenceFromCompleteness, type ReferenceNode } from "./reference-graph.js";
import { expressionReferences, pinnedDependencyBasis, resetReferenceIds, resolveAction, resolveScript, serviceReferences, timeBoxedDependencyBasis } from "./resolve.js";
import { normalizeExecutable, packageManagerCommand, purposeOfLine } from "./purpose.js";
import type { DeclaredPrerequisite } from "./causal.js";
import type { EvidenceRef, InferredOperation, InferredPipeline, ObservedFact, OperationKind, Unresolved } from "./schema.js";

/** Commands that install dependencies, in the form CI actually writes them. */
const INSTALL_PATTERN = /^(npm (ci|install|i)\b|yarn( install)?\b|pnpm (install|i)\b|bun install\b|corepack (npm|yarn|pnpm))/;

/**
 * Actions that install dependencies.
 *
 * A composite action IS an install step even though it contributes no run line. Requiring a run line
 * made `testing-library/jest-dom` — which installs via `bahmutov/npm-install` — look unanalysable for a
 * reason that was about this engine's vocabulary, not the repository.
 */
/**
 * Actions this engine MODELS, and therefore does not treat as an unresolved causal contributor.
 *
 * Stated as what we understand rather than as what to ignore. Anything absent from this list becomes an
 * unresolved edge, so a third-party action cannot silently contribute nothing to a causal path.
 * `checkout`, `setup-*` and `cache` supply the environment the container already stands in for;
 * `upload-artifact` produces rather than consumes and so blocks nothing in a consumer's path.
 */
const MODELLED_ACTION =
  /^(actions\/(checkout|setup-node|setup-python|setup-go|setup-java|cache|upload-artifact)|bahmutov\/npm-install|pnpm\/action-setup|borales\/actions-yarn)/;

const INSTALL_ACTION = /^(bahmutov\/npm-install|pnpm\/action-setup|borales\/actions-yarn)/;

/**
 * ACTION_INPUT_MODELING_01. Actions this engine recognises as carrying a command in one specific, NAMED
 * input — a claim about ONE action's documented contract, never a claim about `with:` keys in general.
 * jest's `nodejs.yml#test-runtime-vm-modules` job runs its real test command as `with.command` of
 * `nick-fields/retry`, a retry wrapper; that command was previously invisible to `purposeOfLine` entirely,
 * because only `workflow.step.run` facts ever became operations.
 *
 * FAIL CLOSED BY CONSTRUCTION: an action absent from this map, or a `with:` key on a listed action that
 * doesn't match the one named here, produces no operation — falls through to `declaredPrerequisites`
 * exactly as before this phase. This is deliberately NOT `carriesCommand`-style key-name matching
 * (`command|run|script|args` on ANY action) — that would license this engine to execute whatever string
 * happens to sit under a suggestively-named key on an action it has never verified the semantics of.
 */
const MODELLED_COMMAND_INPUT: Record<string, string> = {
  "nick-fields/retry": "command",
};

/** The action-name prefix `MODELLED_COMMAND_INPUT` is keyed by, e.g. `nick-fields/retry` from
 *  `nick-fields/retry@ad984534...`. */
function actionName(uses: string): string {
  return uses.split("@")[0]!;
}

// DELETED in SEMANTIC_REPAIR_02: `SCRIPT_RUN`, a second, disagreeing regex that independently decided
// whether a line was a script invocation. `yarn --frozen-lockfile`, `yarn install` and `yarn link
// webpack` all matched it (`([A-Za-z0-9:_-]+)` does not exclude yarn's own flags or built-in
// subcommands), so `resolveScript` was asked whether package.json declares scripts named
// `--frozen-lockfile`, `install` and `link` — correctly "no", and that correct-but-irrelevant answer
// blocked three otherwise-executable operations across jest, webpack and babel (REGRESSION_01's
// adjudication, docs/evidence/regression-01/adjudication.md). `purpose.ts` already asked the identical
// question correctly (`PACKAGE_MANAGER` + `INSTALL_SUBCOMMAND`) to decide `purpose: install` a layer
// above; `packageManagerCommand` is that same logic, now the only place either question is asked.

// DELETED in SEMANTIC_REPAIR_01 layer 2: `KIND_BY_SCRIPT`, `kindOfScript` and `kindOfRunLine`.
//
// `kindOfRunLine` matched /\b(jest|vitest|mocha|ava)\b/ against the WHOLE command line, which made an
// issue-closing command a TEST operation because its comment linked to github.com/jestjs/jest, and made
// `git apply test/patches/jest-worker+30.4.1.patch` a TEST operation because of a patch filename. Two
// external repositories, two unrelated innocent strings, the same defect.
//
// Purpose now comes from `purpose.ts`, derived from the executable position or from a script body the
// repository declares. These are REMOVED rather than left unused: dead code that still encodes the old
// authority is one careless call away from reinstating it, and a test asserts the pattern is absent.

/** Split a CI run line into argv without a shell. Refuses anything with shell control characters. */
function argvOf(line: string): { argv: string[]; unresolved?: Unresolved } {
  if (/[|&;<>$`(){}]/.test(line)) {
    return {
      argv: [],
      unresolved: { what: line, why: "contains shell control characters; running it would need a shell, which this engine does not model" },
    };
  }
  return { argv: line.split(/\s+/).filter(Boolean) };
}

/**
 * Builds the execution graph for one repository — every job, not one.
 *
 * Never executes anything. Reads facts only.
 */
export function inferPipeline(
  repoPath: string,
  repository: string,
  headSha: string,
  facts: ObservedFact[],
  now: string,
  /** ENGINE_COVERAGE_01 item 1. ISO-8601 timestamp, independently sourced from the reference plan's
   *  ciGroundTruth.jobStartedAt — never derived here, never defaulted to `now`. Absent means no
   *  time-boxed basis is available; behavior is then identical to before this parameter existed. */
  dependencyCutoff?: string,
): InferredPipeline {
  resetReferenceIds();
  const references: ReferenceNode[] = [];
  const unresolved: Unresolved[] = [];
  const basis = pinnedDependencyBasis(facts);

  // --- runtime, from what the repository pins for itself ---
  const nodeFile = facts.find((f) => f.kind === "nodeVersionFile");
  const setupNode = facts.find((f) => f.kind === "workflow.step.uses" && f.value.startsWith("actions/setup-node"));
  const runtimeVersion = setupNode?.attributes?.nodeVersion ?? nodeFile?.value;
  const runtimeSource = setupNode?.evidence ?? nodeFile?.evidence;

  const keyOf = (f: ObservedFact): string | undefined =>
    f.attributes?.workflow && f.attributes?.job ? `${f.attributes.workflow}#${f.attributes.job}` : undefined;

  // The repository's own package scripts, read once. Injected into purposeOfLine so that module never
  // touches the filesystem and stays exhaustively testable.
  let declaredScripts: Record<string, string> = {};
  try {
    const pkgPath = join(repoPath, 'package.json');
    if (existsSync(pkgPath)) {
      declaredScripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    }
  } catch {
    /* an unreadable package.json simply declares no scripts */
  }
  const lookupScript = (name: string): string | undefined => declaredScripts[name];

  const jobKeys: string[] = [];
  for (const f of facts) {
    const key = keyOf(f);
    if (key && !jobKeys.includes(key)) jobKeys.push(key);
  }

  const makeOperation = (
    id: string,
    kind: OperationKind,
    command: string[],
    sawVerbatim: boolean,
    evidence: EvidenceRef[],
    dependsOn: string[],
    environment: Record<string, string>,
    opUnresolved: Unresolved[] = [],
    extraRefs: ReferenceNode[] = [],
  ): InferredOperation => {
    const own: ReferenceNode[] = [...extraRefs];
    if (evidence[0] && command.length > 0) {
      const joined = command.join(" ");
      own.push(...expressionReferences(joined, evidence[0]));
      // SEMANTIC_REPAIR_02: the SAME classification purpose.ts uses to decide `purpose: install` vs a
      // script invocation, consumed rather than re-derived. Only `kind === "script"` may ever reach
      // `resolveScript` — an `install` or `builtin` verb is never a script reference, regardless of
      // whether package.json happens to declare a same-named script. Normalised first, same as
      // `purposeOfLine`, so a leading `KEY=value` prefix doesn't hide the package manager from either.
      const pm = packageManagerCommand(normalizeExecutable(joined).tokens);
      if (pm?.kind === "script" && pm.scriptName) own.push(...resolveScript(repoPath, pm.scriptName, evidence[0]));
    }
    references.push(...own);

    // ENGINE_COVERAGE_01 item 1. Considered ONLY for a genuine npm install operation in a repository
    // that has no committed lockfile/packageManager (basis.pinned already false) - never re-evaluated,
    // let alone shown in a receipt, for an already-pinned repository (computeCompleteness's own
    // short-circuit also guards this, but the condition is repeated here so the argv mutation below
    // never happens for a pinned repository either, not just the receipt). Distinct from, never a silent
    // substitute for, DEPENDENCY_BASIS_PINNED - see reference-graph.ts's requirement pair and
    // docs/engine-coverage-01-item-1-implementation-plan.md.
    const timeBoxed =
      kind === "install" && !basis.pinned && command[0]?.toLowerCase() === "npm"
        ? timeBoxedDependencyBasis(facts, dependencyCutoff)
        : { established: false as const, detail: "not applicable to this operation" };
    if (timeBoxed.established && timeBoxed.cutoff) {
      // Appended to the SAME array the caller's `argv` variable references (command is passed by
      // reference), so the flag reaches the actual spawn site (scripts/ci-reproduction.ts's runArm) with
      // no further plumbing - never lost between here and execution.
      command.push(`--before=${timeBoxed.cutoff}`);
    }

    const scriptsResolved = own.filter((n) => n.kind === "SCRIPT_REFERENCE").every((n) => n.resolution === "RESOLVED");
    // DEFECT 30. Each requirement now carries what was OBSERVED, not merely a boolean. The deleted
    // `"a resolved package manager"` was implemented as `command.length > 0` — it duplicated the
    // command check while claiming to have established something about package managers, and webpack's
    // refusal cited it against a repository that pins `yarn@1.22.22` with a committed lockfile.
    const scriptRefs = own.filter((n) => n.kind === "SCRIPT_REFERENCE");
    const completeness = computeCompleteness(
      kind,
      {
        COMMAND_RESOLVED: {
          satisfied: command.length > 0,
          observed: command.length > 0 ? `argv of ${command.length} token(s)` : "no argv could be built for this line",
        },
        WORKING_DIRECTORY_KNOWN: { satisfied: true, observed: "repository root" },
        SCRIPTS_RESOLVED: {
          satisfied: scriptsResolved,
          observed:
            scriptRefs.length === 0
              ? "no script references"
              : `${scriptRefs.filter((n) => n.resolution === "RESOLVED").length}/${scriptRefs.length} script reference(s) resolved`,
        },
        DEPENDENCY_BASIS_PINNED: { satisfied: basis.pinned, observed: basis.detail },
        DEPENDENCY_BASIS_TIME_BOXED: { satisfied: timeBoxed.established, observed: timeBoxed.detail },
      },
      own,
    );

    return {
      id,
      kind,
      command,
      workingDirectory: ".",
      ...(runtimeVersion && runtimeSource ? { runtime: { name: "node" as const, version: runtimeVersion, source: runtimeSource } } : {}),
      environment,
      dependsOn,
      evidence,
      confidence: confidenceFromCompleteness(sawVerbatim, completeness),
      unresolved: opUnresolved,
      ...(command.length === 0 && opUnresolved[0] ? { refusalReason: opUnresolved[0].why } : {}),
      executable: completeness.executable,
      requirementChecks: completeness.checks,
      missingRequirements: completeness.missing,
      blockedBy: completeness.blockedBy.map((n) => n.id),
      willExecute: true,
    };
  };

  /**
   * Causal prerequisites a job DECLARES and this engine cannot follow.
   *
   * Conservative by construction: any `uses:` step that is not in the modelled set becomes an
   * UNRESOLVED causal contributor. That is deliberately NOT name-matching for particular actions -
   * the engine states what it models and everything else is unresolved, so a new third-party action
   * cannot silently contribute nothing.
   *
   * This is where the sample's two capability gaps become visible instead of absent: jest's test
   * command is an input to `nick-fields/retry`, and babel's suite consumes an artifact declared by
   * `actions/download-artifact`. Neither is implemented here; both are now REPRESENTED.
   */
  const declaredPrerequisites = (facts: ObservedFact[]): DeclaredPrerequisite[] => {
    const out: DeclaredPrerequisite[] = [];
    for (const f of facts) {
      if (f.kind !== 'workflow.step.uses') continue;
      if (MODELLED_ACTION.test(f.value)) continue;
      const keys = f.attributes?.withKeys;
      const carriesCommand = keys !== undefined && /\b(command|run|script|args)\b/.test(keys);
      const named = f.attributes?.withName;
      out.push({
        kind: carriesCommand ? 'ACTION_EXECUTION' : 'ARTIFACT',
        identifier: named ? `${f.value} (${named})` : f.value,
        reason: carriesCommand
          ? `the command this step runs is an input (${keys}) to an action this engine does not read`
          : `this step uses ${f.value}, which this engine does not model, so what it contributes is unknown`,
      });
    }
    return out;
  };

  const jobs: InferredJob[] = [];
  for (const key of jobKeys) {
    const [workflow, jobName] = key.split("#");
    const jobFacts = facts.filter((f) => keyOf(f) === key);
    const runFacts = jobFacts.filter((f) => f.kind === "workflow.step.run");
    if (runFacts.length === 0) continue;

    // ACTION_INPUT_MODELING_01. A step whose command lives in a MODELLED action's input is, causally, no
    // different from a `run:` step at the same position - it is one more thing this job does, in order.
    // Synthesised as an ordinary `workflow.step.uses`-kind fact carrying the extracted command as `.value`
    // so the SAME rendering/purpose/argv pipeline below runs unmodified; a new SOURCE of command text,
    // never a new way of interpreting one. Absent from `MODELLED_COMMAND_INPUT`, or missing the one named
    // input, and a `uses:` step contributes nothing here - `declaredPrerequisites` (below) still reports
    // it, exactly as before this phase.
    const modelledUsesSources: ObservedFact[] = [];
    for (const usesFact of jobFacts.filter((f) => f.kind === "workflow.step.uses")) {
      const inputKey = MODELLED_COMMAND_INPUT[actionName(usesFact.value)];
      if (!inputKey) continue;
      const withFact = jobFacts.find(
        (f) => f.kind === "workflow.step.with" && f.attributes?.step === usesFact.attributes?.step && f.attributes?.input === inputKey,
      );
      if (!withFact) continue;
      const raw = withFact.attributes?.value;
      if (raw === undefined) continue;
      modelledUsesSources.push({
        kind: "workflow.step.uses",
        value: raw,
        evidence: { ...withFact.evidence, text: `${usesFact.value} with.${inputKey}: ${withFact.evidence.text}` },
        attributes: usesFact.attributes,
      });
    }
    // Merged and re-sorted by declared step position, not appended after every `run:` step - a modelled
    // action's command depends on whatever installed before it and precedes whatever runs after it, the
    // same as any `run:` line, because GitHub Actions steps are one ordered sequence regardless of kind.
    const runs = [...runFacts, ...modelledUsesSources].sort((a, b) => Number(a.attributes?.step ?? 0) - Number(b.attributes?.step ?? 0));

    const environment: Record<string, string> = {};
    for (const f of jobFacts.filter((f) => f.kind === "workflow.env")) {
      const [k, ...rest] = f.value.split("=");
      if (k) environment[k] = rest.join("=");
    }

    // Services and third-party actions this job depends on become reference nodes attached to it.
    const jobRefs = [
      ...serviceReferences(facts, key),
      ...jobFacts.filter((f) => f.kind === "workflow.step.uses").map((f) => resolveAction(repoPath, f.value, f.evidence)),
    ];
    references.push(...jobRefs);

    // MATRIX EXPANSION (INFERENCE_04). A job with a matrix is really N jobs; representing it as one
    // produced commands containing `${{ matrix.x }}` that could never execute, which is what blocked
    // reproduction. Each instance keeps its exact assignment and the evidence it came from.
    const matrixFact = jobFacts.find((f) => f.kind === "workflow.matrix");
    let parsedMatrix: unknown;
    if (matrixFact) {
      try {
        parsedMatrix = JSON.parse(matrixFact.value);
      } catch {
        parsedMatrix = matrixFact.value;
      }
    }
    const expansion = matrixFact ? expandMatrix(parsedMatrix, matrixFact.evidence) : { instances: [], unsupported: [] };
    for (const u of expansion.unsupported) {
      unresolved.push({ what: u.what, why: u.why, ...(matrixFact ? { evidence: matrixFact.evidence } : {}) });
    }
    // No matrix means exactly one instance with no assignment - the same code path, not a special case.
    const assignments: MatrixAssignment[] = expansion.instances.length > 0 ? expansion.instances : [{}];
    const matrixUnsupported = expansion.unsupported.length > 0;

    for (const [instanceIndex, assignment] of assignments.entries()) {
    const suffix = Object.keys(assignment).length > 0 ? `-${Object.entries(assignment).map(([k, v]) => `${k}${v}`).join("-")}` : "";
    const operations: InferredOperation[] = [];
    let previous: string | undefined;
    for (const [i, fact] of runs.entries()) {
      // GITHUB EXPRESSION SEMANTICS, applied at the rendering boundary (INFERENCE_05).
      //
      // DEFINED_EMPTY and UNDEFINED_CONTEXT both render as "" because that is what GitHub does, so
      // `npm i webpack@ --legacy-peer-deps` is a FAITHFUL reproduction of what this repository's CI
      // actually runs — not command repair. The resolutions are kept so a receipt can say which of the
      // four cases produced the empty, and in particular that html-webpack-plugin references a matrix
      // axis it never declares.
      //
      // UNSUPPORTED_EXPRESSION keeps the line non-renderable: the engine does not know what GitHub
      // would produce, and executing it would run something it cannot account for.
      const context = { matrix: assignment };
      const { rendered, resolutions, renderable } = renderCommand(fact.value, context);
      const line = rendered;
      // LAYER 2, and the rule that matters most here: inference CONSUMES the structural purpose
      // verdict and never rediscovers purpose from raw command text. Removing substring authority in
      // purpose.ts while some consumer re-derived it here would have recreated defect 28 downstream.
      const verdict = purposeOfLine(line, lookupScript);
      const kind = verdict.purpose as OperationKind;

      // The step condition. UNRESOLVED is NOT false: "we could not read the condition" and "the step
      // does not run" are different claims, and only one of them is safe to act on.
      const conditionText = fact.attributes?.if;
      const condition = conditionText !== undefined ? evaluateCondition(conditionText, context, fact.evidence) : undefined;
      // DEFECT 29. UNRESOLVED is NOT false. `undefined` means "we could not read the condition", which
      // is a different claim from "the step does not run" and must not be acted on as if it were.
      const willExecute = condition === undefined ? true : condition.result === "TRUE" ? true : condition.result === "FALSE" ? false : undefined;

      const unsupported = resolutions.find((r: Resolution) => r.kind === "UNSUPPORTED_EXPRESSION");
      const { argv, unresolved: u0 } = !renderable
        ? { argv: [] as string[], unresolved: { what: fact.value, why: unsupported?.reason ?? "an expression in this command is not modelled" } }
        : argvOf(line);
      const conditionBlocks = condition?.result === "UNRESOLVED";
      const u = conditionBlocks
        ? { what: conditionText ?? "", why: condition?.reason ?? "the step condition could not be evaluated" }
        : matrixUnsupported && !u0
          ? { what: fact.value, why: "the job's matrix contains a construct this expander does not model, so no instance can be trusted" }
          : u0;

      const op = makeOperation(
        `${jobName}${suffix}-${kind}-${i}`,
        kind,
        argv,
        true,
        [fact.evidence],
        previous ? [previous] : [],
        environment,
        u ? [u] : [],
      );
      // The two axes, kept separate. A compound line webpack's CI genuinely runs is
      // `purpose TEST + execution UNRESOLVED`: the repository says what the step is for, and only our
      // executor cannot represent it. Collapsing that into `no operation` cost webpack its TEST purpose
      // across all 31 job instances while its real suite ran 57,666 tests.
      const executionRepresentation = argv.length > 0 ? 'RESOLVED' as const : 'UNRESOLVED' as const;
      const decorated: InferredOperation = {
        ...op,
        executionRepresentation,
        purposeBasis: verdict.basis,
        ...(condition ? { condition: { expression: condition.expression, result: condition.result, ...(condition.reason ? { reason: condition.reason } : {}) } } : {}),
        willExecute,
        ...(resolutions.length > 0 ? { expressionResolutions: resolutions.map((r: Resolution) => ({ expression: r.expression, kind: r.kind, value: r.value, ...(r.reason ? { reason: r.reason } : {}) })) } : {}),
        // A step CI skips is not an obstacle to executing the path: it is a step the pipeline does not
        // run in this instance. It stays in the graph, recorded, and executable-by-omission.
        ...(condition?.result === "FALSE" ? { executable: true, missingRequirements: [], blockedBy: [] } : {}),
      };
      operations.push(decorated);
      if (argv.length > 0 && willExecute) previous = decorated.id;
    }

    // A job with no install run line may still install through a composite action, or rely on the
    // lockfile rule. Recorded so the prerequisite is visible rather than silently absent.
    if (!operations.some((o) => o.kind === "install")) {
      const action = jobFacts.find((f) => f.kind === "workflow.step.uses" && INSTALL_ACTION.test(f.value));
      if (action) {
        const u: Unresolved = {
          what: `install is performed by the composite action ${action.value}`,
          why: "a composite action is not a command this engine can execute directly; its effect is an install but its argv is unknown",
          evidence: action.evidence,
        };
        unresolved.push(u);
        operations.unshift({ ...makeOperation(`${jobName}${suffix}-install`, "install", [], true, [action.evidence], [], environment, [u]), willExecute: true });
      }
    }

    jobs.push({
      id: `${key}${suffix}`,
      workflow: workflow ?? "unknown",
      job: `${jobName ?? "unknown"}${suffix}`,
      ...(Object.keys(assignment).length > 0 ? { matrix: assignment, matrixInstance: instanceIndex } : {}),
      provides: jobProvides(operations),
      prerequisites: declaredPrerequisites(jobFacts),
      operations,
      blockedBy: [...new Set(operations.flatMap((o) => o.blockedBy))],
    });
    }
  }

  const operations = jobs.flatMap((j) => j.operations);

  const refusal =
    jobs.length === 0
      ? {
          reason: "no GitHub Actions workflow job with executable steps was found, so how this repository runs CI is unknown",
          evidence: facts.filter((f) => f.kind === "workflow.job").slice(0, 5).map((f) => f.evidence),
        }
      : undefined;

  // THE HARD BOUNDARY, unchanged: an incomplete causal execution path means a decision engine must not
  // act. Reported per-purpose by the planner; this is the whole-pipeline view.
  const nonExecutable = operations.filter((o) => !o.executable);
  const optimisable = !refusal && nonExecutable.length === 0;
  const optimisationRefusal = optimisable
    ? undefined
    : refusal
      ? refusal.reason
      : `${nonExecutable.length} operation(s) are not executable: ${nonExecutable
          .map((o) => `${o.id} (${[...o.missingRequirements, ...o.blockedBy].join(", ")})`)
          .join("; ")}`;

  return {
    schema: "diffci.ci.inference/v1",
    repository,
    headSha,
    facts,
    jobs,
    operations,
    unresolved,
    references,
    optimisable,
    ...(optimisationRefusal ? { optimisationRefusal } : {}),
    ...(refusal ? { refusal } : {}),
    producedAt: now,
  };
}
