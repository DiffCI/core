// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GitHub Actions expression semantics — resolution, and `if:` evaluation.
 *
 * TWO THINGS THAT LOOK ALIKE AND ARE NOT:
 *
 *   DEFINED(empty)      the context HAS the property and its value is ""
 *   UNDEFINED_CONTEXT   the context does NOT have the property
 *
 * GitHub renders both as the empty string, so at the execution boundary they behave identically. They
 * must still be recorded differently, because only one of them means "this workflow references something
 * that does not exist". `html-webpack-plugin` references `matrix.webpack-version` while its matrix
 * declares `webpack`; its CI works by accident, and a receipt that cannot say so would hide the reason
 * the produced command looks wrong.
 *
 * So resolution is structural, and GitHub's coercion is applied at the RENDERING boundary with the
 * provenance attached. `npm i webpack@ --legacy-peer-deps` is then a faithful reproduction of what CI
 * actually runs — not command repair, and the receipt says which of the four cases produced the empty.
 *
 * `if:` evaluates to TRUE / FALSE / UNRESOLVED. **UNRESOLVED is not FALSE.** Treating an unreadable
 * condition as "step does not run" would silently drop operations from a pipeline, which is the same
 * unknown-as-negative error this project has recorded repeatedly.
 */
import type { EvidenceRef } from "./schema.js";

export type ResolutionKind =
  /** The context has the property and it has a non-empty value. */
  | "DEFINED"
  /** The context has the property and its value is the empty string. */
  | "DEFINED_EMPTY"
  /** The context does not have the property. GitHub coerces this to "" at render time. */
  | "UNDEFINED_CONTEXT"
  /** The expression is not one this engine models — a function call, a nested lookup, an operator. */
  | "UNSUPPORTED_EXPRESSION";

export interface Resolution {
  expression: string;
  kind: ResolutionKind;
  /** The value GitHub would substitute. Empty for DEFINED_EMPTY and UNDEFINED_CONTEXT. */
  value: string;
  reason?: string;
}

/** `matrix.<axis>` and nothing else, for now. Anything else is UNSUPPORTED rather than guessed. */
const SIMPLE_CONTEXT = /^([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)$/;

export interface ExpressionContext {
  matrix: Record<string, string>;
}

/** Resolves one `${{ ... }}` body against the context, structurally. */
export function resolveExpression(expression: string, context: ExpressionContext): Resolution {
  const trimmed = expression.trim();
  const simple = SIMPLE_CONTEXT.exec(trimmed);
  if (!simple) {
    return {
      expression: trimmed,
      kind: "UNSUPPORTED_EXPRESSION",
      value: "",
      reason: "only simple `<context>.<property>` lookups are modelled; functions, operators and nested paths are not",
    };
  }
  const [, contextName, property] = simple;
  if (contextName !== "matrix") {
    return {
      expression: trimmed,
      kind: "UNSUPPORTED_EXPRESSION",
      value: "",
      reason: `the \`${contextName}\` context is not modelled by this engine`,
    };
  }
  if (!(property! in context.matrix)) {
    return {
      expression: trimmed,
      kind: "UNDEFINED_CONTEXT",
      value: "",
      reason: `the matrix does not declare an axis named \`${property}\`; GitHub renders this as the empty string`,
    };
  }
  const value = context.matrix[property!]!;
  return { expression: trimmed, kind: value === "" ? "DEFINED_EMPTY" : "DEFINED", value };
}

const EXPRESSION = /\$\{\{([^}]*)\}\}/g;

export interface RenderedCommand {
  /** The line with every expression substituted as GitHub would substitute it. */
  rendered: string;
  resolutions: Resolution[];
  /**
   * Whether the rendered line may be executed.
   *
   * False when any expression is UNSUPPORTED — the engine does not know what GitHub would produce, so
   * running the line would execute something it cannot account for. DEFINED_EMPTY and UNDEFINED_CONTEXT
   * are renderable: GitHub genuinely produces an empty string there, and reproducing that faithfully is
   * the point.
   */
  renderable: boolean;
}

/** Substitutes every expression in a line, applying GitHub's coercion at the boundary. */
export function renderCommand(line: string, context: ExpressionContext): RenderedCommand {
  const resolutions: Resolution[] = [];
  const rendered = line.replace(EXPRESSION, (_match, body: string) => {
    const resolution = resolveExpression(body, context);
    resolutions.push(resolution);
    return resolution.value;
  });
  return { rendered, resolutions, renderable: resolutions.every((r) => r.kind !== "UNSUPPORTED_EXPRESSION") };
}

export type ConditionResult = "TRUE" | "FALSE" | "UNRESOLVED";

export interface ConditionEvaluation {
  expression: string;
  result: ConditionResult;
  reason?: string;
  resolutions: Resolution[];
  evidence?: EvidenceRef;
}

/** `a == b` / `a != b` where each side is a context lookup or a quoted literal. */
const COMPARISON = /^(.+?)\s*(==|!=)\s*(.+)$/;

function operandValue(token: string, context: ExpressionContext): { value: string; resolution?: Resolution } {
  const trimmed = token.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
  const quoted = /^'([^']*)'$/.exec(trimmed) ?? /^"([^"]*)"$/.exec(trimmed);
  if (quoted) return { value: quoted[1]! };
  const resolution = resolveExpression(trimmed, context);
  return { value: resolution.value, resolution };
}

/**
 * Evaluates a step's `if:` for one matrix instance.
 *
 * Supports the subset the frozen execution path actually needs: equality and inequality against a
 * literal, and the bare literals `true`/`false`. Everything else is **UNRESOLVED**, which keeps the
 * affected path non-executable — never FALSE, because "we could not read the condition" and "the step
 * does not run" are different claims and only one of them is safe to act on.
 */
export function evaluateCondition(expression: string, context: ExpressionContext, evidence?: EvidenceRef): ConditionEvaluation {
  const raw = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
  const base = { expression: raw, ...(evidence ? { evidence } : {}) };

  if (/^true$/i.test(raw)) return { ...base, result: "TRUE", resolutions: [] };
  if (/^false$/i.test(raw)) return { ...base, result: "FALSE", resolutions: [] };

  const comparison = COMPARISON.exec(raw);
  if (!comparison) {
    return {
      ...base,
      result: "UNRESOLVED",
      reason: "only equality and inequality against a literal are modelled; the path stays non-executable rather than assuming the step is skipped",
      resolutions: [],
    };
  }

  const [, leftToken, operator, rightToken] = comparison;
  const left = operandValue(leftToken!, context);
  const right = operandValue(rightToken!, context);
  const resolutions = [left.resolution, right.resolution].filter((r): r is Resolution => r !== undefined);

  if (resolutions.some((r) => r.kind === "UNSUPPORTED_EXPRESSION")) {
    return {
      ...base,
      result: "UNRESOLVED",
      reason: `an operand is not modelled: ${resolutions.find((r) => r.kind === "UNSUPPORTED_EXPRESSION")!.reason}`,
      resolutions,
    };
  }

  const equal = left.value === right.value;
  return { ...base, result: (operator === "==" ? equal : !equal) ? "TRUE" : "FALSE", resolutions };
}
