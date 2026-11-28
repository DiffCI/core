// SPDX-License-Identifier: MIT
// Core CI's test step: run the root test files DiffCI selected for this change, or the full suite.
// It narrows only on a clean plan (DIFFCI_FULL exactly "false" and a parseable list of root test
// files); a missing plan, an empty or unexpected list, or any path it does not recognise runs
// everything, the same as `npm test`. Tests of packages/diffci-cli are left to the CLI package job,
// which always runs that package's full suite.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_TEST = /^tests\/(?:[^/\\\0]+\/)*[^/\\\0]+\.test\.ts$/;
const CLI_PACKAGE = 'packages/diffci-cli/';

/**
 * Decide what to run. Returns { mode: 'full', reason } or { mode: 'selected', files, skipped }.
 * `exists` is injected so tests can decide without touching the disk.
 */
export function decide(env, exists) {
  const full = (reason) => ({ mode: 'full', reason });
  if (env.DIFFCI_FULL !== 'false') {
    return full(env.DIFFCI_FULL ? env.DIFFCI_REASON || 'DiffCI required the full suite' : 'no DiffCI plan for this run');
  }
  let listed;
  try {
    listed = JSON.parse(env.DIFFCI_TESTS ?? '');
  } catch {
    return full('the affected test list was missing or not JSON');
  }
  if (!Array.isArray(listed) || !listed.every((file) => typeof file === 'string')) {
    return full('the affected test list was not a list of paths');
  }
  const files = [];
  const skipped = [];
  for (const file of listed) {
    if (file.startsWith(CLI_PACKAGE)) skipped.push(file);
    else if (ROOT_TEST.test(file) && !file.split('/').includes('..') && exists(file)) files.push(file);
    else return full(`unexpected affected test path ${JSON.stringify(file)}`);
  }
  return { mode: 'selected', files, skipped };
}

function summarize(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, `${lines.join('\n')}\n`);
  for (const line of lines) console.log(line.replace(/^#+ /, ''));
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const decision = decide(process.env, (file) => existsSync(join(root, file)));
  const total = process.env.DIFFCI_TOTAL || '?';
  let args;
  if (decision.mode === 'full') {
    summarize(['### Core tests: full suite', '', `Why: ${decision.reason}.`]);
    args = ['tests/**/*.test.ts'];
  } else {
    const lines = [`### Core tests: ${decision.files.length}/${total} files selected by DiffCI`];
    if (decision.skipped.length) lines.push('', `${decision.skipped.length} CLI package test file(s) are left to the CLI package job.`);
    lines.push('', 'The nightly scheduled run covers the full suite.');
    summarize(lines);
    if (decision.files.length === 0) return 0;
    args = decision.files;
  }
  const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = spawnSync(process.execPath, [tsx, '--test', ...args], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
