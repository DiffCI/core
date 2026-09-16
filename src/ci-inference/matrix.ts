// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Matrix expansion — the causal construct that blocked faithful reproduction.
 *
 *   strategy.matrix → concrete assignments → expression substitution → expanded job instances
 *
 * `html-webpack-plugin`'s test path installs `webpack@${{ matrix.webpack }}`, so no plan that leaves the
 * matrix unexpanded can reproduce it. This is deliberately the general construct rather than a special
 * case for that repository: a matrix is how GitHub Actions expresses "this job is really N jobs", and
 * an execution graph that cannot represent that cannot describe most real pipelines.
 *
 * WHAT IS REPRESENTED RATHER THAN IGNORED:
 *
 *   - the cartesian product of the declared axes;
 *   - `include`, which both extends existing combinations and appends new ones;
 *   - `exclude`, which removes them.
 *
 * WHAT MAKES A PATH NON-EXECUTABLE, rather than being silently dropped: any construct this expander
 * does not model — a matrix built by an expression, a non-scalar axis value, or an `include` entry it
 * cannot match. Silently ignoring those would produce a plan that looks complete and reproduces a
 * different pipeline, which is the failure mode this whole workstream exists to prevent.
 *
 * Every instance keeps its exact assignment and the evidence it came from, so a receipt can say WHICH
 * matrix cell it reproduced rather than merely that a matrix existed.
 */
import type { EvidenceRef } from "./schema.js";

/** One concrete cell: axis name → value, e.g. `{ webpack: "5", os: "ubuntu-latest" }`. */
export type MatrixAssignment = Record<string, string>;

export interface MatrixExpansion {
  /** Every concrete instance, in declaration order. */
  instances: MatrixAssignment[];
  /** Constructs the expander could not model. Non-empty ⇒ the affected path is NOT executable. */
  unsupported: Array<{ what: string; why: string }>;
  evidence?: EvidenceRef;
}

/** Only scalars can name a concrete cell; anything else is unsupported rather than coerced. */
function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function sameAssignment(a: MatrixAssignment, b: MatrixAssignment): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** True when `subset`'s keys all match `full` — GitHub's rule for whether an `include` extends a cell. */
function matches(full: MatrixAssignment, subset: MatrixAssignment): boolean {
  return Object.entries(subset).every(([k, v]) => full[k] === undefined || full[k] === v);
}

/**
 * Expands a `strategy.matrix` object into concrete assignments.
 *
 * Follows GitHub's documented semantics: the cartesian product of the axes, then `exclude` removes
 * matching combinations, then `include` extends combinations it matches and appends those it does not.
 */
export function expandMatrix(matrix: unknown, evidence?: EvidenceRef): MatrixExpansion {
  const unsupported: Array<{ what: string; why: string }> = [];

  if (typeof matrix === "string") {
    // e.g. `matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}` — the cells are computed at run time.
    return {
      instances: [],
      unsupported: [{ what: matrix, why: "the matrix is produced by an expression, so its cells are not knowable from repository evidence" }],
      ...(evidence ? { evidence } : {}),
    };
  }
  if (!matrix || typeof matrix !== "object") {
    return { instances: [], unsupported: [{ what: String(matrix), why: "the matrix is not an object" }], ...(evidence ? { evidence } : {}) };
  }

  const source = matrix as Record<string, unknown>;
  const axes: Array<[string, string[]]> = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === "include" || key === "exclude") continue;
    if (!Array.isArray(value)) {
      unsupported.push({ what: `${key}: ${JSON.stringify(value)}`, why: "a matrix axis must be a list of scalars" });
      continue;
    }
    const values: string[] = [];
    for (const entry of value) {
      const s = scalar(entry);
      if (s === undefined) {
        unsupported.push({ what: `${key}: ${JSON.stringify(entry)}`, why: "a matrix axis value that is not a scalar cannot name a concrete cell" });
        continue;
      }
      values.push(s);
    }
    axes.push([key, values]);
  }

  // Cartesian product, in declaration order so expansion is deterministic across runs.
  let instances: MatrixAssignment[] = [{}];
  for (const [key, values] of axes) {
    instances = instances.flatMap((base) => values.map((v) => ({ ...base, [key]: v })));
  }

  const excludeRaw = Array.isArray(source.exclude) ? source.exclude : [];
  for (const entry of excludeRaw) {
    if (!entry || typeof entry !== "object") {
      unsupported.push({ what: JSON.stringify(entry), why: "an exclude entry must be an object" });
      continue;
    }
    const subset: MatrixAssignment = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      const s = scalar(v);
      if (s === undefined) unsupported.push({ what: `exclude ${k}`, why: "non-scalar exclude value" });
      else subset[k] = s;
    }
    instances = instances.filter((i) => !matches(i, subset));
  }

  const includeRaw = Array.isArray(source.include) ? source.include : [];
  for (const entry of includeRaw) {
    if (!entry || typeof entry !== "object") {
      unsupported.push({ what: JSON.stringify(entry), why: "an include entry must be an object" });
      continue;
    }
    const addition: MatrixAssignment = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      const s = scalar(v);
      if (s === undefined) unsupported.push({ what: `include ${k}`, why: "non-scalar include value" });
      else addition[k] = s;
    }
    // GitHub: an include that matches existing combinations EXTENDS them; otherwise it appends a cell.
    const extended = instances.filter((i) => matches(i, addition));
    if (extended.length > 0) {
      instances = instances.map((i) => (matches(i, addition) ? { ...i, ...addition } : i));
    } else if (!instances.some((i) => sameAssignment(i, addition))) {
      instances.push(addition);
    }
  }

  return { instances, unsupported, ...(evidence ? { evidence } : {}) };
}

/** `${{ matrix.x }}` occurrences, whether or not the assignment supplies them. */
const MATRIX_EXPRESSION = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g;

/**
 * Substitutes one assignment into a command line.
 *
 * Returns `undefined` when the line references an axis the assignment does not define — a partially
 * substituted command would be a plausible-looking string that runs something else.
 */
export function substituteMatrix(line: string, assignment: MatrixAssignment): string | undefined {
  let missing = false;
  const out = line.replace(MATRIX_EXPRESSION, (_all, axis: string) => {
    const value = assignment[axis];
    if (value === undefined) {
      missing = true;
      return _all;
    }
    return value;
  });
  return missing ? undefined : out;
}

/** Whether a line still contains any unresolved `${{ }}` expression after substitution. */
export function hasUnresolvedExpression(line: string): boolean {
  return /\$\{\{/.test(line);
}
