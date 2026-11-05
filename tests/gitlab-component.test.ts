// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";

// GitLab rejects a release whose component is not valid YAML. 0.3.28 shipped an unquoted
// "(needs: [])" in an input description, and the catalog release failed with a 422.
test("GitLab component is a valid spec document followed by a valid job document", async () => {
  const text = await readFile("integrations/gitlab/templates/observe/template.yml", "utf8");
  const documents = YAML.parseAllDocuments(text);
  assert.equal(documents.length, 2);
  for (const document of documents) assert.deepEqual(document.errors, []);

  const spec = documents[0]!.toJS() as { spec: { inputs: Record<string, { default?: unknown }> } };
  const { version } = JSON.parse(await readFile("packages/diffci-cli/package.json", "utf8")) as { version: string };
  assert.equal(spec.spec.inputs["cli-version"]?.default, version);

  const job = documents[1]!.toJS() as Record<string, { script?: unknown }>;
  assert.deepEqual(Object.keys(job), ["$[[ inputs.job-name ]]"]);
});

test("GitLab catalog pipeline is valid YAML", async () => {
  const text = await readFile("integrations/gitlab/.gitlab-ci.yml", "utf8");
  for (const document of YAML.parseAllDocuments(text)) assert.deepEqual(document.errors, []);
});
