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

// While a job has id-token: write, every step can request the OIDC token that npm trusted publishing accepts, so a
// dependency's install script there could publish a package with valid provenance (#301). Such jobs install nothing
// with scripts enabled and publish only with --ignore-scripts; building and packing happen in a job without it.
test("jobs that can mint an OIDC token run no install or lifecycle scripts", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
    const workflow = parse(readFileSync(new URL(name, directory), "utf8"));
    for (const [id, job] of Object.entries<Job>(workflow.jobs ?? {})) {
      const permissions = job.permissions ?? workflow.permissions;
      const mintsOidc = permissions === "write-all" || (typeof permissions === "object" && permissions?.["id-token"] === "write");
      if (!mintsOidc) continue;
      for (const step of job.steps ?? []) {
        for (const line of (step.run ?? "").split("\n")) {
          const command = line.trim();
          const installs = /\bnpm (ci|install|i|pack|rebuild|exec)\b|\bnpx\b|\b(yarn|pnpm|bun)\b/.test(command);
          const publishes = /\bnpm publish\b/.test(command);
          if ((installs || publishes) && !/--ignore-scripts\b/.test(command)) offenders.push(`${name} ${id}: ${command}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the release publishes the tarball the build job packed, in a job without a write token", () => {
  const workflow = parse(readFileSync(new URL("release-cli.yml", directory), "utf8"));
  assert.deepEqual(workflow.jobs.build.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.publish.permissions, { "id-token": "write" });
  assert.ok(workflow.jobs.publish.needs.includes("build"));
  const publishSteps: Step[] = workflow.jobs.publish.steps;
  assert.ok(!publishSteps.some((step) => step.uses?.startsWith("actions/checkout@")), "publish checks nothing out");
  assert.ok(publishSteps.some((step) => /npm publish "\$PACKAGE_FILE" .*--provenance --ignore-scripts/.test(step.run ?? "")));
  assert.equal(workflow.jobs.release.permissions["id-token"], undefined);
});
