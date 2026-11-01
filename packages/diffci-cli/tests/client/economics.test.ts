import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { economicsContext, evaluateEconomics } from "../../src/client/economics.js";
import { observe } from "../../src/client/observe.js";

const context = { repository: "owner/repo", jobKey: "unit-linux-node22", contextKey: "config", observerVersion: "candidate", now: Date.now() };
const history = () => ({ schema: "diffci.economics.v1", repository: context.repository, jobKey: context.jobKey, contextKey: context.contextKey, observerVersion: context.observerVersion, recordedAt: new Date(context.now).toISOString(), samples: Array.from({ length: 5 }, (_, index) => ({ headSha: index.toString(16).padStart(40, "0"), stable: true, fullMs: 20000, policyMs: 19800, observerMs: 2000 })) });

test("economics requires matching, recent, stable history across distinct commits", () => {
  assert.equal(evaluateEconomics(history(), context).decision, "BYPASS_FULL");
  for (const invalid of [undefined, {}, { ...history(), contextKey: "other" }, { ...history(), jobKey: "browser" }, { ...history(), repository: "other/repo" }, { ...history(), observerVersion: "old" }, { ...history(), recordedAt: new Date(context.now - 49 * 3600000).toISOString() }, { ...history(), recordedAt: new Date(context.now + 1).toISOString() }, { ...history(), samples: history().samples.slice(0, 4) }, { ...history(), samples: history().samples.map(sample => ({ ...sample, headSha: "a".repeat(40) })) }, { ...history(), samples: history().samples.map(sample => ({ ...sample, stable: false })) }, { ...history(), samples: history().samples.map(sample => ({ ...sample, fullMs: Infinity })) }]) {
    assert.equal(evaluateEconomics(invalid, context).decision, "ANALYZE");
  }
  const profitable = history(); profitable.samples[0].policyMs = 1000;
  assert.equal(evaluateEconomics(profitable, context).decision, "ANALYZE");
});

test("economics bypass precedes graph construction, never emits a selection, and supports resampling", async () => {
  const root = mkdtempSync(join(tmpdir(), "diffci-economics-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("remote", "add", "origin", "https://github.com/owner/repo.git");
    writeFileSync(join(root, "package.json"), '{"devDependencies":{"vitest":"1"}}');
    writeFileSync(join(root, "tsconfig.json"), "INVALID_CONFIG_PROVES_NO_GRAPH");
    const heads: string[] = [];
    for (let i = 0; i < 6; i++) { writeFileSync(join(root, "source.ts"), `export const value = ${i};`); git("add", "."); git("commit", "--quiet", "-m", `change ${i}`); heads.push(git("rev-parse", "HEAD")); }
    const h = { ...history(), contextKey: economicsContext(root), samples: history().samples.map((sample, index) => ({ ...sample, headSha: heads[index] })) };
    const options = { repoPath: root, env: {}, version: context.observerVersion, baseOverride: heads[4], headOverride: heads[5], economicsJobKey: context.jobKey, economicsHistory: h };
    const result = await observe(options);
    assert.equal(result.status, "REFUSED");
    assert.equal(result.economics?.decision, "BYPASS_FULL");
    assert.equal(result.result, undefined);
    assert.equal(result.timings.phasesMs?.engineLoad, undefined);
    assert.equal(result.nonInterference.worktreeUnchanged, true);
    const forced = await observe({ ...options, forceAnalysis: true });
    assert.equal(forced.economics?.decision, "ANALYZE");
    assert.equal(forced.status, "ERROR");
    const future = { ...h, samples: [...h.samples.slice(0, 4), { ...h.samples[4], headSha: heads[5] }] };
    assert.equal((await observe({ ...options, economicsHistory: future })).economics?.decision, "ANALYZE");
    writeFileSync(join(root, "package.json"), '{"devDependencies":{"vitest":"2"}}');
    assert.notEqual(economicsContext(root), h.contextKey);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
