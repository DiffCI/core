// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Evidence collection — reads the repository and concludes NOTHING.
 *
 * Every function here returns `ObservedFact`s with a file and, where meaningful, a line. Nothing in this
 * file decides what a fact means; that is `infer.ts`. Keeping the split physical rather than merely
 * conventional is what stops "we saw npm ci" and "npm ci is the install command" collapsing into one
 * record, which is the failure the schema exists to prevent.
 *
 * It never executes the repository.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { EvidenceRef, ObservedFact } from "./schema.js";

/** Finds the 1-indexed line of the first occurrence of `needle`, for citable evidence. */
function lineOf(source: string, needle: string): number | undefined {
  const index = source.indexOf(needle);
  if (index === -1) return undefined;
  return source.slice(0, index).split("\n").length;
}

function ref(file: string, text: string, source?: string): EvidenceRef {
  return { file, text: text.length > 200 ? `${text.slice(0, 200)}…` : text, line: source ? lineOf(source, text) : undefined };
}

/** package.json facts: scripts, packageManager, engines, declared test runners. */
export function packageFacts(repoPath: string): ObservedFact[] {
  const file = "package.json";
  const full = join(repoPath, file);
  if (!existsSync(full)) return [];
  let source: string;
  let pkg: Record<string, any>;
  try {
    source = readFileSync(full, "utf8");
    pkg = JSON.parse(source) as Record<string, any>;
  } catch {
    return [];
  }
  const facts: ObservedFact[] = [];
  for (const [name, value] of Object.entries(pkg.scripts ?? {})) {
    if (typeof value !== "string") continue;
    facts.push({ kind: "package.script", value, evidence: ref(file, value, source), attributes: { script: name } });
  }
  if (typeof pkg.packageManager === "string") {
    facts.push({ kind: "package.packageManager", value: pkg.packageManager, evidence: ref(file, pkg.packageManager, source) });
  }
  if (pkg.engines?.node) {
    facts.push({ kind: "package.engines", value: String(pkg.engines.node), evidence: ref(file, String(pkg.engines.node), source), attributes: { engine: "node" } });
  }
  const declared = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) } as Record<string, string>;
  for (const runner of ["jest", "vitest", "mocha", "ava", "jasmine", "tap", "karma", "kcd-scripts", "jest-runner-eslint"]) {
    if (declared[runner]) {
      facts.push({ kind: "package.dependency", value: `${runner}@${declared[runner]}`, evidence: ref(file, runner, source), attributes: { name: runner } });
    }
  }
  return facts;
}

/** Which lockfile is committed. The repository's own statement about its package manager. */
export function lockfileFacts(repoPath: string): ObservedFact[] {
  const facts: ObservedFact[] = [];
  for (const name of ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "npm-shrinkwrap.json"]) {
    if (existsSync(join(repoPath, name))) {
      facts.push({ kind: "lockfile.present", value: name, evidence: { file: name, text: name } });
    }
  }
  return facts;
}

/** `.nvmrc` / `.node-version` — the runtime the repository pins for itself. */
export function nodeVersionFacts(repoPath: string): ObservedFact[] {
  const facts: ObservedFact[] = [];
  for (const name of [".nvmrc", ".node-version", ".tool-versions"]) {
    const full = join(repoPath, name);
    if (!existsSync(full)) continue;
    try {
      const text = readFileSync(full, "utf8").trim();
      facts.push({ kind: "nodeVersionFile", value: text, evidence: { file: name, text } });
    } catch {
      /* unreadable is simply not a fact */
    }
  }
  return facts;
}

/** Runner configuration files present at the root, cited but not interpreted here. */
export function runnerConfigFacts(repoPath: string): ObservedFact[] {
  const facts: ObservedFact[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(repoPath);
  } catch {
    return facts;
  }
  for (const name of entries.sort()) {
    if (!/^(jest|vitest|karma|ava|mocha|babel|tsconfig)[.a-z0-9-]*\.(json|js|cjs|mjs|ts|mts|cts|yml|yaml)$/i.test(name)) continue;
    try {
      if (!statSync(join(repoPath, name)).isFile()) continue;
    } catch {
      continue;
    }
    facts.push({ kind: "runnerConfig", value: name, evidence: { file: name, text: name } });
  }
  return facts;
}

/**
 * GitHub Actions workflows — the repository's own statement of how it runs CI.
 *
 * This is the evidence the generic derivation never looked at, and it is the reason four of the six
 * benchmark repositories failed: a workflow says how the project really installs, builds and tests, and
 * a manifest often does not.
 *
 * Parsed with the real YAML parser; a workflow that does not parse yields NO facts rather than guesses.
 */
export function workflowFacts(repoPath: string): ObservedFact[] {
  const dir = join(repoPath, ".github", "workflows");
  if (!existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const facts: ObservedFact[] = [];
  for (const name of entries.sort()) {
    if (!/\.(yml|yaml)$/i.test(name)) continue;
    const file = `.github/workflows/${name}`;
    let source: string;
    let doc: Record<string, any>;
    try {
      source = readFileSync(join(dir, name), "utf8");
      doc = parseYaml(source) as Record<string, any>;
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object" || typeof doc.jobs !== "object") continue;

    for (const [jobId, job] of Object.entries(doc.jobs as Record<string, any>)) {
      if (!job || typeof job !== "object") continue;
      const attrs = { workflow: name, job: jobId };
      facts.push({ kind: "workflow.job", value: jobId, evidence: ref(file, jobId, source), attributes: attrs });

      if (job.strategy?.matrix) {
        facts.push({
          kind: "workflow.matrix",
          value: JSON.stringify(job.strategy.matrix),
          evidence: ref(file, "matrix", source),
          attributes: attrs,
        });
      }
      if (job.services) {
        facts.push({ kind: "workflow.services", value: JSON.stringify(Object.keys(job.services)), evidence: ref(file, "services", source), attributes: attrs });
      }
      for (const [key, value] of Object.entries((job.env ?? {}) as Record<string, unknown>)) {
        facts.push({ kind: "workflow.env", value: `${key}=${String(value)}`, evidence: ref(file, key, source), attributes: attrs });
      }

      const steps = Array.isArray(job.steps) ? job.steps : [];
      for (const [i, step] of steps.entries()) {
        if (!step || typeof step !== "object") continue;
        // The step condition travels WITH every fact this step produces, `uses:` included - a step CI
        // skips is still a declared step, and dropping the condition would make "skipped" indistinguishable
        // from "never existed". Previously computed only inside the `run:` branch below (`withCondition`),
        // which left every `workflow.step.uses`/`workflow.step.with` fact silently unconditional even when
        // the step itself declared an `if:` - correct for `nick-fields/retry`'s specific step (it has
        // none), but a gap ACTION_INPUT_MODELING_01's new operations must not inherit for the next action.
        const stepAttrs = {
          ...attrs,
          step: String(i),
          ...(step.name ? { name: String(step.name) } : {}),
          ...(typeof step.if === "string" || typeof step.if === "boolean" ? { if: String(step.if) } : {}),
        };
        if (typeof step.uses === "string") {
          // The `with:` INPUTS are recorded, not interpreted.
          //
          // Two of the sample's five members hid their real causal structure in here: jest's test
          // command is `with.command` of `nick-fields/retry`, and babel's suite consumes `with.name`
          // of `actions/download-artifact`. Both were invisible because this collector kept only
          // `node-version`, so the engine could not even represent that something was missing.
          //
          // This is EVIDENCE ACQUISITION. Nothing here decides what an input means; recording the
          // keys is what later lets a causal edge be marked unresolved instead of being absent.
          const inputs = step.with && typeof step.with === "object" ? (step.with as Record<string, unknown>) : {};
          const inputKeys = Object.keys(inputs).slice(0, 20);
          facts.push({
            kind: "workflow.step.uses",
            value: step.uses,
            evidence: ref(file, step.uses, source),
            attributes: {
              ...stepAttrs,
              ...(inputs["node-version"] ? { nodeVersion: String(inputs["node-version"]) } : {}),
              ...(inputKeys.length > 0 ? { withKeys: inputKeys.join(",") } : {}),
              ...(inputs.name ? { withName: String(inputs.name).slice(0, 200) } : {}),
            },
          });
          for (const key of inputKeys) {
            const raw = String(inputs[key]).slice(0, 400);
            // Prefer the line the VALUE itself appears on over the owning `uses:` line, so a command
            // extracted from here (ACTION_INPUT_MODELING_01) cites where it was actually written. Falls
            // back to the `uses:` line when the value's own text can't be found verbatim (a multi-line
            // YAML block scalar, for instance, won't match this single-line search).
            const valueEvidence = lineOf(source, raw) !== undefined ? ref(file, raw, source) : ref(file, step.uses, source);
            facts.push({
              kind: "workflow.step.with",
              value: `${key}=${raw}`,
              evidence: valueEvidence,
              // `attributes.value` is the raw input value alone, additive: existing consumers reading
              // `.value` as `"key=value"` are unaffected; ACTION_INPUT_MODELING_01 reads this instead of
              // re-parsing the combined string.
              attributes: { ...stepAttrs, input: key, action: step.uses, value: raw },
            });
          }
        }
        if (typeof step.run === "string") {
          // Multi-line `run:` blocks are several commands; each line is its own fact.
          for (const line of step.run.split("\n").map((l: string) => l.trim()).filter(Boolean)) {
            facts.push({ kind: "workflow.step.run", value: line, evidence: ref(file, line, source), attributes: stepAttrs });
          }
        }
        for (const [key, value] of Object.entries((step.env ?? {}) as Record<string, unknown>)) {
          facts.push({ kind: "workflow.env", value: `${key}=${String(value)}`, evidence: ref(file, key, source), attributes: stepAttrs });
        }
      }
    }
  }
  return facts;
}

/** Everything observable, in one pass. Order is stable so two runs produce identical evidence. */
export function collectEvidence(repoPath: string): ObservedFact[] {
  return [
    ...workflowFacts(repoPath),
    ...packageFacts(repoPath),
    ...lockfileFacts(repoPath),
    ...nodeVersionFacts(repoPath),
    ...runnerConfigFacts(repoPath),
  ];
}
