// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";
import {
  buildPilotWorkflow,
  CHECKOUT_SHA,
  RUNNER,
  SETUP_NODE_SHA,
  UPLOAD_ARTIFACT_SHA,
  diffciVerificationWorkflow,
  diffciWorkflow,
} from "../packages/diffci-cli/src/client/workflow-templates.js";

type Workflow = { jobs: Record<string, { "runs-on": unknown; steps: Array<{ uses?: string }> }> };

const VERSION = "9.8.7";
const GENERATED = {
  observation: diffciWorkflow(VERSION),
  verification: diffciVerificationWorkflow(VERSION),
  pilot: buildPilotWorkflow(VERSION),
};

/** Node 24 releases; Node 20 releases such as checkout/setup-node/upload-artifact v4 must not return. */
const NODE_24_PINS: Record<string, string> = {
  "actions/checkout": CHECKOUT_SHA,
  "actions/setup-node": SETUP_NODE_SHA,
  "actions/upload-artifact": UPLOAD_ARTIFACT_SHA,
};

for (const [name, source] of Object.entries(GENERATED)) {
  test(`generated ${name} workflow runs on Ubuntu 26.04`, () => {
    const workflow = YAML.parse(source) as Workflow;
    const jobs = Object.values(workflow.jobs);
    assert.ok(jobs.length > 0);
    for (const job of jobs) assert.equal(job["runs-on"], "ubuntu-26.04");
  });

  test(`generated ${name} workflow pins every action to its Node 24 commit`, () => {
    const uses = Object.values((YAML.parse(source) as Workflow).jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
    );
    assert.ok(uses.length > 0);
    for (const reference of uses) {
      const [action, ref] = reference.split("@");
      assert.ok(action && action in NODE_24_PINS, `${name} uses an unexpected action: ${reference}`);
      assert.equal(ref, NODE_24_PINS[action], `${name} must pin ${action} to its Node 24 commit`);
    }
    assert.doesNotMatch(source, /@v\d/, `${name} must not use a floating major tag`);
    assert.ok(source.includes(`@diffci.com/diffci@${VERSION}`), `${name} must pin the CLI version`);
  });
}

test("verification and pilot workflows upload their receipt with upload-artifact v7", () => {
  for (const source of [GENERATED.verification, GENERATED.pilot]) {
    assert.ok(source.includes(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA} # immutable upload-artifact v7 pin`));
  }
});

test("generated workflows use the same runner and pins as Core's own workflows", async () => {
  assert.equal(RUNNER, "ubuntu-26.04");
  const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(action.includes(`actions/setup-node@${SETUP_NODE_SHA}`), "Observer Action must share the setup-node pin");
  assert.ok(action.includes(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`), "Observer Action must share the upload-artifact pin");
  assert.ok(ci.includes(`actions/checkout@${CHECKOUT_SHA}`), "Core CI must share the checkout pin");
  assert.ok(ci.includes(`os: [${RUNNER}, windows-latest]`), "Core CI must test on the generated runner");
});
