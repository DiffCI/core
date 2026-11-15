// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";

type CompositeAction = {
  name: string;
  inputs: Record<string, { default?: unknown }>;
  outputs: Record<string, unknown>;
  runs: {
    using: string;
    steps: Array<{ id?: string; env?: Record<string, string>; run?: string; uses?: string }>;
  };
};

const ALLOWED_CONTEXTS = new Set(["inputs", "github", "env", "steps", "runner"]);

function expressions(text: string): string[] {
  return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]!.trim());
}

function descriptions(node: unknown, path = "action"): Array<{ path: string; text: string }> {
  if (Array.isArray(node)) return node.flatMap((value, index) => descriptions(value, `${path}[${index}]`));
  if (!node || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    key === "description" && typeof value === "string"
      ? [{ path: `${path}.${key}`, text: value }]
      : descriptions(value, `${path}.${key}`)
  );
}

async function readAction(): Promise<{ raw: string; action: CompositeAction }> {
  const raw = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  return { raw, action: YAML.parse(raw) as CompositeAction };
}

async function cliVersion(): Promise<string> {
  const raw = await readFile(new URL("../packages/diffci-cli/package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(raw) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("CLI package must declare a version");
  return manifest.version;
}

test("public observer Action preserves the reviewed observer contract", async () => {
  const { raw, action } = await readAction();

  assert.equal(action.name, "DiffCI change impact");
  assert.equal(action.runs.using, "composite");
  assert.deepEqual(Object.keys(action.inputs), [
    "repository-path",
    "base-sha",
    "head-sha",
    "node-version",
    "cli-version",
    "report-path",
    "redact-paths",
    "upload-artifact",
    "artifact-name",
    "artifact-retention-days",
    "api-url",
    "api-token",
    "fail-on-error",
    "comment",
    "github-token",
    "verify",
    "verify-checks",
    "verify-timeout-minutes",
    "check-run",
    "check-run-name"
  ]);
  assert.equal(action.inputs.comment?.default, "false", "commenting is opt-in");
  assert.equal(action.inputs.verify?.default, "false", "running repository code is opt-in");
  assert.equal(action.inputs["check-run"]?.default, "false", "posting a check run is opt-in");
  assert.deepEqual(Object.keys(action.outputs), [
    "report-path",
    "status",
    "full-suite-required",
    "affected-tests",
    "affected-test-count",
    "total-test-count",
    "reason",
    "verify-status",
    "gate-conclusion",
    "agent"
  ]);
  assert.match(raw, /cd "\$RUNNER_TEMP"/);
  assert.match(raw, /uses: actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);
  assert.equal(action.inputs["cli-version"]?.default, await cliVersion());
  assert.match(raw, /DIFFCI_CLI_VERSION: \$\{\{ inputs\.cli-version \}\}/);
  assert.match(raw, /DIFFCI_CLI_VERSION" =~ \^\(0\|\[1-9\]\[0-9\]\*\)\\\./);
  assert.ok(raw.includes('npx --yes --ignore-scripts --no-audit --fund=false --package "@diffci.com/diffci@$DIFFCI_CLI_VERSION" diffci'));
  assert.match(raw, /uses: actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/);
});

test("public observer Action uses only composite-action contexts and safe descriptions", async () => {
  const { raw, action } = await readAction();
  for (const expression of expressions(raw)) {
    const contexts = [...expression.matchAll(/(?<![\w.'])([a-zA-Z_]+)\s*\./g)].map((match) => match[1]!);
    for (const context of contexts) assert.ok(ALLOWED_CONTEXTS.has(context), `expression "${expression}" uses unsupported context "${context}"`);
  }
  for (const description of descriptions(action)) {
    assert.equal(expressions(description.text).length, 0, `${description.path} contains an expression`);
  }
});

test("public observer Action passes its token only through the environment", async () => {
  const { action } = await readAction();
  const observe = action.runs.steps.find((step) => step.id === "observe");
  assert.ok(observe, "observe step is present");
  assert.equal(observe.env?.DIFFCI_TOKEN, "${{ inputs.api-token }}");
  assert.doesNotMatch(observe.run ?? "", /api-token|DIFFCI_TOKEN/, "the token is never placed on a command line");
});

test("public observer Action passes the comment token only through the environment", async () => {
  const { action } = await readAction();
  const impact = action.runs.steps.find((step) => step.id === "impact");
  assert.ok(impact, "impact step is present");
  assert.equal(impact.env?.DIFFCI_GITHUB_TOKEN, "${{ inputs.github-token }}");
  assert.equal(impact.run, 'node "$GITHUB_ACTION_PATH/action/impact.mjs"');
});

test("public observer Action runs the fast check only on request, after the impact answer", async () => {
  const { action } = await readAction();
  const ids = action.runs.steps.map((step) => step.id);
  assert.ok(ids.indexOf("verify") > ids.indexOf("impact"), "verify reads the impact outputs");
  const verify = action.runs.steps.find((step) => step.id === "verify") as { if?: string; env?: Record<string, string>; run?: string };
  assert.match(verify.if ?? "", /inputs\.verify == 'true'/);
  assert.equal(verify.run, 'bash "$GITHUB_ACTION_PATH/action/verify.sh"', "inputs reach the script only through the environment");
  assert.equal(verify.env?.DIFFCI_FULL, "${{ steps.impact.outputs.full-suite-required }}");
  const upload = action.runs.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@")) as { if?: string };
  assert.match(upload.if ?? "", /^\$\{\{ always\(\) &&/, "the report is kept when the fast check fails");
});

test("public observer Action posts the merge gate only on request, after the fast check, with the token in the environment", async () => {
  const { action } = await readAction();
  const ids = action.runs.steps.map((step) => step.id);
  assert.ok(ids.indexOf("gate") > ids.indexOf("verify"), "the gate reads the fast check's status");
  const gate = action.runs.steps.find((step) => step.id === "gate") as { if?: string; env?: Record<string, string>; run?: string };
  assert.equal(gate.if, "${{ always() && inputs.check-run == 'true' }}", "it reports a failed fast check too");
  assert.equal(gate.run, 'node "$GITHUB_ACTION_PATH/action/check-run.mjs"');
  assert.equal(gate.env?.DIFFCI_GITHUB_TOKEN, "${{ inputs.github-token }}");
  assert.equal(gate.env?.DIFFCI_VERIFY_STATUS, "${{ steps.verify.outputs.status }}");
});

test("public observer Action fetches missing history only into a shallow checkout", async () => {
  const { action } = await readAction();
  const ids = action.runs.steps.map((step) => step.id);
  assert.ok(ids.indexOf("history") >= 0 && ids.indexOf("history") < ids.indexOf("observe"), "history is fetched before observing");
  const history = action.runs.steps.find((step) => step.id === "history");
  assert.match(history?.run ?? "", /rev-parse --is-shallow-repository/);
  assert.match(history?.run ?? "", /fetch --quiet --no-tags --unshallow origin/);
  assert.doesNotMatch(history?.run ?? "", /git -C "\$DIFFCI_REPO" (checkout|reset|clean|switch|pull|merge)/, "only git objects are added");
});
