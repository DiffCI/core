// SPDX-License-Identifier: MIT
// Public, fail-closed pilot. Run ONLY against a disposable official glob clone.
// This harness prepares dependencies and runs tests; the analyzer does neither.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { analyzeGitDelta, buildDependencyGraph, ImpactAnalyzer, DefaultCIPlanner, createTaskRegistry } from '../dist/index.js';
import { repositoryFileReader } from '../dist/repo/file-references.js';

const upstream = 'https://github.com/rust-lang/glob.git';
const pinnedHead = '057cef2824f5a96f738e52d7d8ca3e024381bcc6';
const revisions = [
  ['8a903ef83cdc3ac4be8a16c4160c570fcfead655', '1f753241f047175126d1be051718d1a0994d29f4'],
  ['0639988caf1c644b78629cd0f7d65f4d0a4920c9', '335da33c46daaa7db629ad77e07a9531909d9dfd'],
  ['335da33c46daaa7db629ad77e07a9531909d9dfd', 'e0b33b0fac2d83f37e737e7207e75a36339380a6'],
];
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!['--repo', '--disposable-root', '--output', '--prepare-dependencies'].includes(key) || key in options) throw new Error(`Invalid/duplicate argument: ${key}`);
  options[key] = key === '--prepare-dependencies' ? true : args[++i];
}
if (!options['--repo'] || !options['--disposable-root'] || !options['--output'] || !options['--prepare-dependencies']) {
  throw new Error('Usage: node scripts/replay-rust.mjs --repo PATH --disposable-root PATH --output FILE --prepare-dependencies (authorizes Cargo lockfile generation and dependency fetch in that disposable clone)');
}
const repo = realpathSync(options['--repo']);
const disposableRoot = realpathSync(options['--disposable-root']);
const child = relative(disposableRoot, repo);
if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('--repo must be strictly inside the explicitly supplied disposable root');
const core = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
if (repo === core || !relative(core, repo).startsWith('..')) throw new Error('Target must be outside the Core checkout');
const output = resolve(options['--output']);
if (!relative(repo, output).startsWith('..')) throw new Error('Report must be outside the target checkout');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function run(command, commandArgs, cwd = repo, timeout = 600_000) {
  const start = performance.now();
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  return { command: [command, ...commandArgs], exitCode: result.status, signal: result.signal, durationMs: Math.round(performance.now() - start), stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) };
}
function requireSuccess(result) {
  if (result.exitCode !== 0) throw new Error(`${result.command.join(' ')} failed: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
const git = (...commandArgs) => requireSuccess(run('git', commandArgs));
const status = () => git('status', '--porcelain=v1', '--untracked-files=all');
function clean() {
  if (status()) throw new Error('Target checkout is dirty; refusing to modify or clean it');
}
if (realpathSync(git('rev-parse', '--show-toplevel')) !== repo) throw new Error('--repo must be the repository root');
if (git('remote', 'get-url', 'origin') !== upstream) throw new Error(`Expected official origin ${upstream}`);
if (git('rev-parse', 'HEAD') !== pinnedHead) throw new Error(`Start the disposable clone at ${pinnedHead}`);
clean();
for (const [head, base] of revisions) {
  git('merge-base', '--is-ancestor', head, pinnedHead);
  if (git('rev-parse', `${head}^`) !== base) throw new Error(`Unexpected parent for ${head}`);
}
const report = {
  schema: 'diffci.rust-public-replay.v1', startedAt: new Date().toISOString(),
  repository: upstream, pinnedHead, coreHead: requireSuccess(run('git', ['rev-parse', 'HEAD'], core)),
  coreTrackedStatus: requireSuccess(run('git', ['status', '--porcelain=v1', '--untracked-files=no'], core)),
  environment: { node: process.version, platform: process.platform, architecture: process.arch, cargo: requireSuccess(run('cargo', ['--version'])), rustc: requireSuccess(run('rustc', ['-Vv'])), runnerImage: process.env.ImageVersion ?? null },
  scope: 'Three historical source-changing deltas, one Linux default cargo test baseline per head. Not an equivalent replacement for upstream CI, platform/toolchain matrix, features, or other commands.',
  preparation: 'Harness explicitly generates Cargo.lock and fetches dependencies before read-only analysis. Lockfile bytes and hashes are captured. Analyzer uses offline locked Cargo metadata and does not download dependencies.',
  measurement: 'One full run per revision, sequential with shared build cache; timings include compilation and are not a benchmark or evidence of avoided compute.',
  avoidedComputeClaim: false, selectedCommandsExecuted: false, replays: [],
};
mkdirSync(dirname(output), { recursive: true });
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
save();
try {
  for (const [head, base] of revisions) {
    clean();
    git('checkout', '--detach', head);
    const replay = { head, base, subject: git('show', '-s', '--format=%s', head), preparation: [] };
    report.replays.push(replay);
    save();
    // No tracked source is edited. glob intentionally ignores its generated Cargo.lock.
    git('check-ignore', 'Cargo.lock');
    if (git('ls-files', 'Cargo.lock')) throw new Error('Expected untracked generated lockfile');
    for (const commandArgs of [['generate-lockfile'], ['fetch', '--locked']]) {
      const result = run('cargo', commandArgs);
      replay.preparation.push(result);
      save();
      requireSuccess(result);
    }
    const lockfile = readFileSync(join(repo, 'Cargo.lock'), 'utf8');
    replay.lockfile = { sha256: sha256(lockfile), contents: lockfile };
    clean();
    replay.stateBeforeAnalysis = { head: git('rev-parse', 'HEAD'), status: status(), lockfileSha256: sha256(lockfile) };
    const start = performance.now();
    const deltaResult = await analyzeGitDelta({ repoPath: repo, baseSha: base, headSha: head });
    if (!deltaResult.success) throw new Error(JSON.stringify(deltaResult.error));
    if (!deltaResult.delta.files.some(file => file.path.endsWith('.rs'))) throw new Error('Replay must change Rust source');
    const graph = await buildDependencyGraph({ repoPath: repo });
    const impact = new ImpactAnalyzer().analyze(deltaResult.delta, graph, graph.profile, {
      repositoryFiles: deltaResult.inventory?.files, readRepositoryFile: repositoryFileReader(repo),
    });
    // An empty task registry avoids inventing executable CI tasks for the target.
    // Command synthesis still uses the target's actual profile and invocation evidence.
    const plan = new DefaultCIPlanner(createTaskRegistry([])).plan({ delta: deltaResult.delta, impact, profile: graph.profile });
    replay.analysis = {
      durationMs: Math.round(performance.now() - start), changes: deltaResult.delta.files,
      adapters: graph.profile.adapters, adapterBlockers: graph.adapterBlockers,
      adapterMetrics: graph.performance.adapterMetrics, graphConfidence: graph.confidence,
      rustTestInvocation: graph.profile.rustTestInvocation ?? null,
      rustTestPackages: graph.profile.rustTestPackages, rustTestTargets: graph.profile.rustTestTargets,
      discoveredTestFiles: graph.profile.testFilePaths,
      graphAffectedTests: impact.affectedTests.map(test => test.path), impact, plan,
    };
    replay.stateAfterAnalysis = { head: git('rev-parse', 'HEAD'), status: status(), lockfileSha256: sha256(readFileSync(join(repo, 'Cargo.lock'))) };
    if (JSON.stringify(replay.stateBeforeAnalysis) !== JSON.stringify(replay.stateAfterAnalysis)) throw new Error('Analyzer changed target state');
    save();
    // Always run the independent full baseline, never execute a synthesized subset.
    replay.fullTest = run('cargo', ['test', '--offline', '--locked']);
    replay.fullTest.resultSummaries = [...replay.fullTest.stdout.matchAll(/^test result:.*$/gm)].map(match => match[0]);
    replay.stateAfterTests = { head: git('rev-parse', 'HEAD'), status: status(), lockfileSha256: sha256(readFileSync(join(repo, 'Cargo.lock'))) };
    if (JSON.stringify(replay.stateBeforeAnalysis) !== JSON.stringify(replay.stateAfterTests)) throw new Error('Full baseline changed target state');
    clean();
    save();
  }
  report.status = report.replays.every(replay => replay.fullTest.exitCode === 0) ? 'PASSED' : 'FAILED';
  report.summary = {
    replays: report.replays.length,
    fullFallbacks: report.replays.filter(replay => replay.analysis.plan.mode === 'FULL').length,
    fullTestsPassed: report.replays.filter(replay => replay.fullTest.exitCode === 0).length,
    selectiveRunsExecuted: 0, avoidedComputeClaim: false,
    interpretation: report.replays.every(replay => replay.analysis.plan.mode === 'FULL')
      ? 'Zero selectivity: fail-closed public replay. No avoided-compute claim.'
      : 'Advisory selection only; no selected execution or avoided-compute claim.',
  };
} catch (error) {
  report.status = 'FAILED';
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  // Never force checkout, reset, clean, or remove files, including on failure.
  try { clean(); git('checkout', '--detach', pinnedHead); }
  catch (error) { report.restoreError = String(error); report.status = 'FAILED'; }
  report.finishedAt = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ status: report.status, ...report.summary, error: report.error, report: output }));
if (report.status !== 'PASSED') process.exitCode = 1;
