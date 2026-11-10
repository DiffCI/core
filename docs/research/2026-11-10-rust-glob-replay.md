# Rust public replay: glob, 2026-11-10

## Result

All three historical source-changing revisions of [rust-lang/glob](https://github.com/rust-lang/glob) retained **FULL** validation. All three independent full Cargo baselines passed. No selective command was executed, and this replay establishes **zero selectivity and no avoided-compute claim**.

This validates the adapter's conservative fallback on a real filesystem-oriented crate. It does not establish selective correctness for arbitrary Rust repositories, reproduce glob's CI matrix, or demonstrate a performance improvement. Positive crate-selection coverage currently comes from the synthetic workspace tests.

## Evidence and environment

- [Hosted replay run](https://github.com/DiffCI/core/actions/runs/42828196139), completed successfully on 2026-11-10 at 13:50:49 UTC.
- [Machine-readable report](2026-11-10-rust-glob-replay.json), including exact deltas, Cargo output, dependency-lock bytes/hashes, blockers, plans and checkout-state receipts.
- Core PR head: `8d0ba78eed600a7d84ddadc4def6c4e1e6d0dd2a`; GitHub tested merge commit: `017320e7f939e15222a950958ee3e0cb7af90e1a`, whose tree matches the PR head. The report was added afterward without changing the engine or harness.
- Official target history pinned beneath `057cef2824f5a96f738e52d7d8ca3e024381bcc6`.
- GitHub-hosted Ubuntu 26.04 x64, image `20261101.186.1`; Node `v24.22.2`; Cargo and rustc `1.99.1`.

| Target head | Exact parent | Plan | Full baseline | Observed command wall time |
| --- | --- | --- | --- | --- |
| [`8a903ef83cdc`](https://github.com/rust-lang/glob/commit/8a903ef83cdc3ac4be8a16c4160c570fcfead655), edition 2021 | `1f753241f047175126d1be051718d1a0994d29f4` | FULL | Passed | 7.527 s |
| [`0639988caf1c`](https://github.com/rust-lang/glob/commit/0639988caf1c644b78629cd0f7d65f4d0a4920c9), cache filename for sorting | `335da33c46daaa7db629ad77e07a9531909d9dfd` | FULL | Passed | 1.759 s |
| [`335da33c46da`](https://github.com/rust-lang/glob/commit/335da33c46daaa7db629ad77e07a9531909d9dfd), Into conversion | `e0b33b0fac2d83f37e737e7207e75a36339380a6` | FULL | Passed | 0.688 s |

Each baseline reported 18 unit tests, 1 integration test and 5 doctests passing, with 2 doctests ignored by the target itself. Timings include compilation and sequential reuse of one build cache. They are single observations, not benchmark comparisons.

## Why the adapter retained the full suite

Each revision discovered two test-target identities, `src/lib.rs` and `tests/glob-std.rs`. Both remained selected. The graph reported UNSAFE and explicit blockers for:

- Dependencies outside the workspace whose runtime inputs are opaque.
- Dependency feature unification requiring the original workspace invocation.
- Build scripts in the resolved dependency set.
- Runtime inputs or unsupported include/path behavior in the crate and integration-test sources.

Command synthesis was NOT_APPLICABLE because the repository's original full test command applies. These results must not be described as a selective run that happened to pass.

## Reproduction

Use the `Rust public repository replay` GitHub Actions workflow or run the harness in a disposable clone outside Core. Build Core with `npm ci` and `npm run build`, clone the official repository, and check out the pinned target head above. Then run:

```sh
node scripts/replay-rust.mjs \
  --repo /tmp/disposable-rust-replay/glob \
  --disposable-root /tmp/disposable-rust-replay \
  --output /tmp/rust-replay-report.json \
  --prepare-dependencies
```

The harness verifies the official origin, pinned ancestry, exact parents and clean state. It explicitly generates an ignored Cargo.lock and fetches dependencies before read-only analysis, then executes `cargo test --offline --locked` as the independent full baseline at each head. Dependency preparation belongs to this harness; the analyzer itself does not fetch or generate a lockfile.

The generated lockfile had SHA-256 `e520ab8782edb3b0ca6bce25668d6eb637b592e364cd6a8ae676626feb9ed699` at all three heads. Analysis and full tests preserved tracked checkout state and that lockfile. The raw report retains the lockfile contents so future dependency resolution can be compared rather than assumed identical.

## Remaining boundary

The initial selective path supports local workspace crates with complete source/input coverage and a reproducible plain Cargo test invocation. Broader dependency runtime-input coverage, feature-context reproduction and CI invocation support need additional evidence before this public repository can safely narrow. This replay completes the public-report milestone of #62 while keeping those limitations explicit.
