/**
 * Phase 02 (2026-08-26): the workflow guard has to catch the ways an "inert" job stops being inert.
 *
 * The cases below are not hypothetical shapes. They are what a well-meaning installation looks like
 * when someone adds DiffCI to an existing workflow the obvious way: pasted into the job that already
 * checks out and builds, with no continue-on-error, referenced by a floating tag - and then the build
 * job waits on it, and one DiffCI timeout turns a green pull request red.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { auditWorkflows, isNonInterfering } from "../../src/client/workflow-guard.js";

const PINNED = `owner/DiffCI.com@${"0".repeat(40)}`;

function repoWithWorkflow(contents: string, fileName = "ci.yml"): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-guard-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", fileName), contents);
  return dir;
}

function codes(dir: string): string[] {
  return auditWorkflows(dir).findings.map((finding) => finding.code).sort();
}

const CLEAN = `
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ${PINNED}
`;

describe("workflow non-interference guard", () => {
  it("does not treat registry tag removal as an observation job", () => {
    const dir = repoWithWorkflow(`${CLEAN}\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm dist-tag rm @diffci.com/diffci latest || true\n`);
    try {
      const result = auditWorkflows(dir);
      assert.deepEqual(result.observerJobs, [`${join(".github", "workflows", "ci.yml")}#diffci`]);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const script of [
    "npm dist-tag rm @diffci.com/diffci latest || true\n          npx @diffci.com/diffci observe",
    "npm dist-tag rm @diffci.com/diffci latest; npx @diffci.com/diffci observe",
    "npm dist-tag rm @diffci.com/diffci latest || npx @diffci.com/diffci observe",
  ]) {
    it(`still audits an observer alongside registry operations: ${script}`, () => {
      const dir = repoWithWorkflow(`jobs:\n  unsafe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${script}\n`);
      try {
        assert.ok(codes(dir).includes("JOB_NOT_CONTINUE_ON_ERROR"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("passes a dedicated, pinned, continue-on-error, read-only job", () => {
    const dir = repoWithWorkflow(CLEAN);
    try {
      const result = auditWorkflows(dir);
      assert.deepEqual(result.observerJobs, [`${join(".github", "workflows", "ci.yml")}#diffci`]);
      assert.deepEqual(result.findings, []);
      assert.equal(isNonInterfering(result), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when another job needs the observer", () => {
    const dir = repoWithWorkflow(`
name: CI
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: ${PINNED}
  deploy:
    runs-on: ubuntu-latest
    needs: diffci
    steps:
      - run: ./deploy.sh
`);
    try {
      assert.ok(codes(dir).includes("JOB_IS_A_DEPENDENCY"));
      assert.equal(isNonInterfering(auditWorkflows(dir)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a job without continue-on-error, because the workflow conclusion is what a required check reads", () => {
    const dir = repoWithWorkflow(`
name: CI
jobs:
  diffci:
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED}
`);
    try {
      assert.ok(codes(dir).includes("JOB_NOT_CONTINUE_ON_ERROR"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks the obvious installation: pasted into the job that already builds", () => {
    const dir = repoWithWorkflow(`
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
      - uses: ${PINNED}
`);
    try {
      assert.ok(codes(dir).includes("JOB_NOT_DEDICATED"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when the observer inherits write permissions from the workflow", () => {
    const dir = repoWithWorkflow(`
name: CI
permissions:
  contents: write
  pull-requests: write
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: ${PINNED}
`);
    try {
      const finding = auditWorkflows(dir).findings.find((f) => f.code === "JOB_HAS_WRITE_PERMISSIONS");
      assert.ok(finding, "expected a write-permission finding");
      assert.match(finding.message, /inherits/);
      assert.match(finding.message, /contents, pull-requests/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns about a floating action reference, and accepts a 40-character SHA", () => {
    const floating = repoWithWorkflow(`
name: CI
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: owner/DiffCI.com@v1
`);
    try {
      assert.ok(codes(floating).includes("ACTION_NOT_PINNED"));
    } finally {
      rmSync(floating, { recursive: true, force: true });
    }

    const pinned = repoWithWorkflow(CLEAN);
    try {
      assert.equal(codes(pinned).includes("ACTION_NOT_PINNED"), false);
    } finally {
      rmSync(pinned, { recursive: true, force: true });
    }
  });

  it("warns when the observer shares a concurrency group with another job", () => {
    const dir = repoWithWorkflow(`
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    concurrency:
      group: ci-\${{ github.ref }}
    steps:
      - run: npm test
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    concurrency:
      group: ci-\${{ github.ref }}
    steps:
      - uses: ${PINNED}
`);
    try {
      assert.ok(codes(dir).includes("JOB_SHARES_CONCURRENCY_GROUP"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unparseable workflow rather than silently skipping it", () => {
    const dir = repoWithWorkflow("this: is: not: valid: yaml:\n  - [\n");
    try {
      const result = auditWorkflows(dir);
      assert.ok(result.findings.some((f) => f.code === "WORKFLOW_UNPARSEABLE"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognises a local `uses: ./` installation, which has no \"diffci\" in the step at all", () => {
    const dir = repoWithWorkflow(`
name: CI
jobs:
  observe:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: ./
`);
    try {
      writeFileSync(join(dir, "action.yml"), "name: DiffCI observer\ndescription: x\nruns:\n  using: composite\n  steps: []\n");
      const result = auditWorkflows(dir);
      assert.equal(result.observerJobs.length, 1, "the local action reference was not recognised");
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds no observer jobs in a repository that has not installed it", () => {
    const dir = repoWithWorkflow(`
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
    try {
      const result = auditWorkflows(dir);
      assert.deepEqual(result.observerJobs, []);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not misclassify a dedicated fail-closed verification check as an observer", () => {
    const dir = repoWithWorkflow(`
name: DiffCI verification
jobs:
  diffci-verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - run: npx "@diffci.com/diffci@0.2.9" verify --json
`);
    try {
      const result = auditWorkflows(dir);
      assert.deepEqual(result.observerJobs, []);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognises the repository's source-mode verification command", () => {
    const dir = repoWithWorkflow(`
name: DiffCI verification
jobs:
  diffci-verify:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm run typecheck
      - run: node --import tsx src/client/cli.ts verify --json --out "$RUNNER_TEMP/diffci-verification.json"
`);
    try {
      const result = auditWorkflows(dir);
      assert.deepEqual(result.observerJobs, []);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("run: steps - what counts as running DiffCI (2026-09-06)", () => {
  const RUN_FORMS = `
name: CI
jobs:
  npm-form:
    runs-on: ubuntu-latest
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: |
          npm install --prefix "\${RUNNER_TEMP}/diffci" --no-audit --no-fund @diffci/observer@1.4.2
          "\${RUNNER_TEMP}/diffci/node_modules/.bin/diffci" observe
  docker-form:
    runs-on: ubuntu-latest
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: docker run --rm -v "\${{ github.workspace }}:/workspace:ro" ghcr.io/diffci/observer@sha256:${"a".repeat(64)} observe --repo /workspace
`;
  const URL_ONLY = `
name: Deploy shadow research Worker
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Deploy and verify source integrity
        run: |
          # talks to the diffci research Worker - a URL, not an invocation
          npx tsx scripts/deploy-research-sandbox.ts --url https://diffci-research-sandbox.damp-waterfall-0cd8.workers.dev
          curl -fsS "https://diffci-research-sandbox.damp-waterfall-0cd8.workers.dev/v1/shadow/cron-status?limit=1"
`;

  it("recognises every run: form the product generates - npm install + .bin/diffci, and docker image@digest", () => {
    const dir = repoWithWorkflow(RUN_FORMS);
    try {
      const result = auditWorkflows(dir);
      assert.deepEqual(result.observerJobs.sort(), [`${join(".github", "workflows", "ci.yml")}#docker-form`, `${join(".github", "workflows", "ci.yml")}#npm-form`]);
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a URL or comment naming diffci is data, not an invocation - the deploy workflow is not an observer job", () => {
    const dir = repoWithWorkflow(URL_ONLY, "shadow-deploy.yml");
    try {
      const result = auditWorkflows(dir);
      assert.deepEqual(result.observerJobs, [], "no job here runs DiffCI");
      assert.deepEqual(codes(dir), [], "and so nothing about the deploy job is a finding");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still flags a mutable agent reference on a real invocation, and ignores an @ inside a URL", () => {
    const dir = repoWithWorkflow(`
name: CI
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: |
          curl -fsS https://user@diffci-research-sandbox.example.workers.dev/health
          npx @diffci/observer@latest observe
`);
    try {
      const found = codes(dir);
      assert.ok(found.length === 1 && /MUTABLE|PIN/i.test(found[0]!), `expected exactly one pin finding for @latest, got ${JSON.stringify(found)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
