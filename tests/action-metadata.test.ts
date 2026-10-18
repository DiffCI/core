// SPDX-License-Identifier: AGPL-3.0-only
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

  assert.equal(action.name, "DiffCI Core observer");
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
    "fail-on-error"
  ]);
  assert.deepEqual(Object.keys(action.outputs), ["report-path", "status"]);
  assert.match(raw, /cd "\$RUNNER_TEMP"/);
  assert.match(raw, /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.equal(action.inputs["cli-version"]?.default, await cliVersion());
  assert.match(raw, /DIFFCI_CLI_VERSION: \$\{\{ inputs\.cli-version \}\}/);
  assert.match(raw, /DIFFCI_CLI_VERSION" =~ \^\(0\|\[1-9\]\[0-9\]\*\)\\\./);
  assert.ok(raw.includes('npx --yes --ignore-scripts --no-audit --fund=false --package "@diffci.com/diffci@$DIFFCI_CLI_VERSION" diffci'));
  assert.match(raw, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
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
