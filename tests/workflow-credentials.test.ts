// SPDX-License-Identifier: MIT
// actions/checkout writes the job's GITHUB_TOKEN into .git/config unless persist-credentials is false, and every
// later step can read it there, including dependency install scripts. A job whose token can write must not leave
// it on disk unless the job itself pushes with git.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const directory = new URL("../.github/workflows/", import.meta.url);

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string> | string; steps?: Step[] };

/** True when the job's token gets a write scope git could use; id-token is not stored by checkout. */
function writesWithToken(permissions: Job["permissions"]): boolean {
  if (permissions === "write-all") return true;
  if (!permissions || typeof permissions === "string") return false;
  return Object.entries(permissions).some(([scope, access]) => scope !== "id-token" && access === "write");
}

test("jobs with a write token do not persist it in the checkout unless they push", () => {
  const offenders: string[] = [];
  const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.includes("release-cli.yml"));
  for (const name of files) {
    const workflow = parse(readFileSync(new URL(name, directory), "utf8"));
    for (const [id, job] of Object.entries<Job>(workflow.jobs ?? {})) {
      if (!writesWithToken(job.permissions ?? workflow.permissions)) continue;
      const steps = job.steps ?? [];
      if (steps.some((step) => /\bgit push\b/.test(step.run ?? ""))) continue;
      for (const step of steps) {
        if (step.uses?.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false) offenders.push(`${name} ${id}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
