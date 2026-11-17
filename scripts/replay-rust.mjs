// SPDX-License-Identifier: MIT
// Public, fail-closed pilot. Run ONLY against a disposable official clone of a pinned target.
// This harness prepares dependencies and runs tests; the analyzer does neither.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { analyzeGitDelta, buildDependencyGraph, ImpactAnalyzer, DefaultCIPlanner, createTaskRegistry } from '../dist/index.js';
import { repositoryFileReader } from '../dist/repo/file-references.js';
import { planRustTestCommands } from '../dist/planner/rust-command.js';

// Each target is an official repository, a pinned head and exact [head, parent] pairs beneath it.
const targets = {
  glob: {
    upstream: 'https://github.com/rust-lang/glob.git',
    pinnedHead: '057cef2824f5a96f738e52d7d8ca3e024381bcc6',
    revisions: [
      ['8a903ef83cdc3ac4be8a16c4160c570fcfead655', '1f753241f047175126d1be051718d1a0994d29f4'],
      ['0639988caf1c644b78629cd0f7d65f4d0a4920c9', '335da33c46daaa7db629ad77e07a9531909d9dfd'],
      ['335da33c46daaa7db629ad77e07a9531909d9dfd', 'e0b33b0fac2d83f37e737e7207e75a36339380a6'],
    ],
  },
  // A virtual workspace of six crates (url, idna, form_urlencoded, percent_encoding, data-url and
  // url_debug_tests). The first three deltas each change one library crate; the last changes url,
  // whose path-handling code depends on every crate, so it is expected to stay FULL.
  'rust-url': {
    upstream: 'https://github.com/servo/rust-url.git',
    pinnedHead: 'bcf5a2a98986dd5dfb252d3e977d2da380b09fda',
    revisions: [
      ['13b385b299238306d2601ddc1c0043afcd2f2046', 'cad4a844d8de6100f18b0ca17603ac3866a13c1f'],
      ['55ff72dd676ae6657d0b8d7dd005233210da76d2', '9a04be18b36cd08e933da06554af0d83bf3fb31b'],
      ['828b28c95034953e353c1559fd28520a2f01ca80', '15e0b57e5881e3c5a622b38a7e7d6efffcecb8e5'],
      ['bcf5a2a98986dd5dfb252d3e977d2da380b09fda', '13b385b299238306d2601ddc1c0043afcd2f2046'],
    ],
  },
};
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!['--repo', '--disposable-root', '--output', '--prepare-dependencies', '--target'].includes(key) || key in options) throw new Error(`Invalid/duplicate argument: ${key}`);
  options[key] = key === '--prepare-dependencies' ? true : args[++i];
}
if (!options['--repo'] || !options['--disposable-root'] || !options['--output'] || !options['--prepare-dependencies']) {
  throw new Error('Usage: node scripts/replay-rust.mjs [--target glob|rust-url] --repo PATH --disposable-root PATH --output FILE --prepare-dependencies (authorizes Cargo lockfile generation and dependency fetch in that disposable clone)');
}
const targetName = options['--target'] ?? 'glob';
if (!Object.hasOwn(targets, targetName)) throw new Error(`Unknown target: ${targetName}`);
const { upstream, pinnedHead, revisions } = targets[targetName];
const repo = realpathSync(options['--repo']);
const disposableRoot = realpathSync(options['--disposable-root']);
const child = relative(disposableRoot, repo);
if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('--repo must be strictly inside the explicitly supplied disposable root');
const core = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
if (repo === core || !relative(core, repo).startsWith('..')) throw new Error('Target must be outside the Core checkout');
const output = resolve(options['--output']);
if (!relative(repo, output).startsWith('..')) throw new Error('Report must be outside the target checkout');
const sha256 = value => createHash('sha256').update(value).digest('hex');
let logNumber = 0;
let workDirectory;
// Cargo logs and fault-injection clones go to a fresh directory beside the target, never inside it.
const work = () => workDirectory ??= mkdtempSync(join(disposableRoot, 'replay-work-'));
function run(command, commandArgs, cwd = repo, timeout = 600_000, combined = false) {
  const start = performance.now();
  // Cargo writes test-binary headers to stderr and test results to stdout. One descriptor preserves
  // their order, so tests with the same name in different binaries never collapse into one result.
  const logPath = combined ? join(work(), `cargo-output-${++logNumber}.log`) : undefined;
  const fd = logPath ? openSync(logPath, 'wx') : undefined;
  let result;
  try { result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, ...(fd === undefined ? {} : { stdio: ['ignore', fd, fd] }) }); }
  finally { if (fd !== undefined) closeSync(fd); }
  return { command: [command, ...commandArgs], exitCode: result.status, signal: result.signal, durationMs: Math.round(performance.now() - start),
    stdout: logPath ? readFileSync(logPath, 'utf8') : result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) };
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
/** Every test Cargo ran, keyed by test binary (crate and target, build hash removed) and test name.
 * Unparseable output yields no results, which the comparison below treats as a failure. */
function testResults(output) {
  const results = {};
  let binary;
  for (const line of output.split(/\r?\n/)) {
    const running = /^\s+Running (?:unittests )?(\S+) \((?:[^)]*[\\/])?([^)\\/]+?)(?:-[0-9a-f]{16})?(?:\.exe)?\)$/.exec(line);
    if (running) { binary = `${running[2]} ${running[1]}`; continue; }
    const doc = /^\s+Doc-tests (\S+)$/.exec(line);
    if (doc) { binary = `doc ${doc[1]}`; continue; }
    const result = /^test (.+?) \.\.\. (ok|FAILED|ignored)(?:, .*)?$/.exec(line);
    if (result && binary) results[`${binary} :: ${result[1]}`] = result[2];
  }
  return results;
}
/** The selected run must report every test it ran with the full run's outcome, and every full-run
 * failure must be in it: it catches the same failures, and never invents a pass or a failure. */
function compareRuns(full, selected) {
  const fullResults = testResults(`${full.stdout}\n${full.stderr}`);
  const selectedResults = testResults(`${selected.stdout}\n${selected.stderr}`);
  const failures = runs => Object.entries(runs).filter(([, outcome]) => outcome === 'FAILED').map(([name]) => name).sort();
  const notInFull = Object.keys(selectedResults).filter(name => !Object.hasOwn(fullResults, name)).sort();
  const differentOutcome = Object.keys(selectedResults).filter(name => Object.hasOwn(fullResults, name) && fullResults[name] !== selectedResults[name]).sort();
  const missedFailures = failures(fullResults).filter(name => selectedResults[name] !== 'FAILED');
  return {
    fullTests: Object.keys(fullResults).length, selectedTests: Object.keys(selectedResults).length,
    fullFailures: failures(fullResults), selectedFailures: failures(selectedResults),
    notInFull, differentOutcome, missedFailures,
    sameFailures: Object.keys(fullResults).length > 0 && Object.keys(selectedResults).length > 0
      && notInFull.length === 0 && differentOutcome.length === 0 && missedFailures.length === 0
      && (full.exitCode === 0) === (selected.exitCode === 0),
  };
}
const offline = command => ({ ...command, args: [...command.args, '--offline', '--locked'] });
function runCommands(commands, cwd) {
  const outputs = commands.map(command => run(command.executable, offline(command).args, cwd, 600_000, true));
  return { commands: outputs, exitCode: outputs.every(output => output.exitCode === 0) ? 0 : 1,
    stdout: outputs.map(output => output.stdout).join('\n'), stderr: outputs.map(output => output.stderr).join('\n') };
}
const summarize = result => ({ ...result, stdout: undefined, stderr: undefined, stdoutSha256: sha256(result.stdout), resultSummaries: [...result.stdout.matchAll(/^test result:.*$/gm)].map(match => match[0]) });

if (realpathSync(git('rev-parse', '--show-toplevel')) !== repo) throw new Error('--repo must be the repository root');
if (git('remote', 'get-url', 'origin') !== upstream) throw new Error(`Expected official origin ${upstream}`);
if (git('rev-parse', 'HEAD') !== pinnedHead) throw new Error(`Start the disposable clone at ${pinnedHead}`);
clean();
for (const [head, base] of revisions) {
  git('merge-base', '--is-ancestor', head, pinnedHead);
  if (git('rev-parse', `${head}^`) !== base) throw new Error(`Unexpected parent for ${head}`);
}
const report = {
  schema: 'diffci.rust-public-replay.v2', startedAt: new Date().toISOString(),
  target: targetName, repository: upstream, pinnedHead, coreHead: requireSuccess(run('git', ['rev-parse', 'HEAD'], core)),
  coreTrackedStatus: requireSuccess(run('git', ['status', '--porcelain=v1', '--untracked-files=no'], core)),
  environment: { node: process.version, platform: process.platform, architecture: process.arch, cargo: requireSuccess(run('cargo', ['--version'])), rustc: requireSuccess(run('rustc', ['-Vv'])), runnerImage: process.env.ImageVersion ?? null },
  scope: `${revisions.length} historical source-changing deltas, one Linux default cargo test baseline per head. Not an equivalent replacement for upstream CI, platform/toolchain matrix, features, or other commands.`,
  selection: 'For a SELECTIVE plan the harness runs the selected cargo test commands next to the full baseline and compares every reported test. The commands come from the plan when the target CI gives plain cargo test evidence; otherwise from the same planner with the harness baseline (plain cargo test --offline --locked, no flags or compiler environment) as the invocation evidence. A fault injected into the changed Rust file in a separate local clone must fail both runs.',
  preparation: 'Harness explicitly generates Cargo.lock and fetches dependencies before read-only analysis. Lockfile bytes and hashes are captured. Analyzer uses offline locked Cargo metadata and does not download dependencies.',
  measurement: 'One full run per revision, sequential with shared build cache; timings include compilation and are not a benchmark or evidence of avoided compute.',
  avoidedComputeClaim: false, replays: [],
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
    // Always run the independent full baseline.
    const fullTest = run('cargo', ['test', '--offline', '--locked'], repo, 600_000, true);
    replay.fullTest = summarize(fullTest);
    if (plan.mode === 'SELECTIVE' && plan.selectedTests.length) {
      const commandPlan = plan.commandSpecs.length ? { commands: plan.commandSpecs }
        : planRustTestCommands({ ...graph.profile, rustTestInvocation: 'cargo test' }, plan.selectedTests);
      const source = plan.commandSpecs.length ? 'diffci-plan' : 'harness-baseline-evidence';
      if (!commandPlan.commands.length) throw new Error(`Selective plan without runnable Cargo commands: ${commandPlan.refusalReason}`);
      const selected = runCommands(commandPlan.commands, repo);
      replay.selectedTest = { source, ...summarize(selected), comparison: compareRuns(fullTest, selected) };
      save();
      // Inject one failing test into the changed Rust file, in a separate local clone with its own
      // build directory, and check that both runs report it. The target checkout is not edited.
      const changed = deltaResult.delta.files.find(file => file.path.endsWith('.rs') && file.changeType !== 'deleted');
      const scratch = join(work(), `fault-${head.slice(0, 12)}`);
      requireSuccess(run('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, scratch], disposableRoot));
      requireSuccess(run('git', ['checkout', '--quiet', '--detach', head], scratch));
      copyFileSync(join(repo, 'Cargo.lock'), join(scratch, 'Cargo.lock'));
      appendFileSync(join(scratch, changed.path), '\n#[cfg(test)]\nmod diffci_replay_injected_fault {\n    #[test]\n    fn diffci_replay_injected_fault() {\n        panic!("DiffCI replay injected fault");\n    }\n}\n');
      const faultFull = run('cargo', ['test', '--offline', '--locked', '--no-fail-fast'], scratch, 600_000, true);
      const faultSelected = runCommands(commandPlan.commands.map(command => ({ ...command, args: [...command.args, '--no-fail-fast'] })), scratch);
      const comparison = compareRuns(faultFull, faultSelected);
      replay.injectedFault = { file: changed.path, scratch: relative(disposableRoot, scratch), fullTest: summarize(faultFull), selectedTest: summarize(faultSelected), comparison,
        caught: faultFull.exitCode !== 0 && faultSelected.exitCode !== 0 && comparison.selectedFailures.some(name => name.endsWith('diffci_replay_injected_fault::diffci_replay_injected_fault')) && comparison.sameFailures };
    }
    replay.stateAfterTests = { head: git('rev-parse', 'HEAD'), status: status(), lockfileSha256: sha256(readFileSync(join(repo, 'Cargo.lock'))) };
    if (JSON.stringify(replay.stateBeforeAnalysis) !== JSON.stringify(replay.stateAfterTests)) throw new Error('Full baseline changed target state');
    clean();
    save();
  }
  const selective = report.replays.filter(replay => replay.selectedTest);
  report.status = report.replays.every(replay => replay.fullTest.exitCode === 0)
    && selective.every(replay => replay.selectedTest.comparison.sameFailures && replay.injectedFault?.caught) ? 'PASSED' : 'FAILED';
  report.summary = {
    replays: report.replays.length,
    fullFallbacks: report.replays.filter(replay => replay.analysis.plan.mode === 'FULL').length,
    narrowed: selective.map(replay => ({ head: replay.head, selectedTests: replay.analysis.plan.selectedTests.length, totalTests: replay.analysis.discoveredTestFiles.length,
      commands: replay.selectedTest.commands.map(command => command.command.join(' ')), commandSource: replay.selectedTest.source,
      testsRun: { full: replay.selectedTest.comparison.fullTests, selected: replay.selectedTest.comparison.selectedTests },
      sameFailures: replay.selectedTest.comparison.sameFailures, injectedFaultCaught: replay.injectedFault?.caught ?? false })),
    fullTestsPassed: report.replays.filter(replay => replay.fullTest.exitCode === 0).length,
    selectiveRunsExecuted: selective.length, avoidedComputeClaim: false,
    interpretation: selective.length === 0
      ? 'Zero selectivity: fail-closed public replay. No avoided-compute claim.'
      : 'Selected commands ran next to each full baseline and reported the same failures. Timings are single sequential observations with a shared build cache, not an avoided-compute claim.',
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
