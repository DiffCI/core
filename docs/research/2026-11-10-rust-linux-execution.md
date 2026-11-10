# Rust Linux execution validation, 2026-11-10

## Result

The complete Rust branch stack was tested directly on Linux before any upstream merge. The generated selective command ran **6 Rust tests instead of 9** in a controlled three-crate workspace. It preserved unit, named integration and doctest coverage, skipped the unrelated crate, and detected three independently seeded production-code regressions.

This is executable regression evidence for the supported workspace boundary, not a public-project savings measurement.

- Tested source: [e1228a6](https://github.com/FredApps/core/commit/e1228a68534a112cd34f60d18ff7858092a87557).
- [Machine-readable evidence](2026-11-10-rust-linux-execution.json) contains commands, test outcomes, real fixture Git deltas and the public replay summary.
- Linux x86_64, Node 24.18.0, Cargo/rustc 1.99.1.
- Final exact-source suite: **859 passed, 0 failed, 0 skipped**. Typecheck, build, release-boundary audit, agent packaging and benchmark also passed. The final run completed at 15:48:53 UTC.
- Separate CLI package typecheck/build, package-boundary and packed-install smoke checks passed using the standard install flow. That package retains its own pinned Core dependency; these are packaging regression checks, not proof that the published CLI already contains this adapter.

## What the selective test executes

The fixture creates a real Git repository with three local packages: leaf, consumer and unrelated. It commits a baseline, a behavior-preserving arithmetic refactor, and separate unit-test, integration-test and doctest regressions. Every plan starts from actual base/head Git changes and verified HEAD inventory.

Real offline/locked Cargo metadata feeds the registered graph, impact analysis and planner. The test executes the generated argv unchanged:

```sh
cargo test -p execution-consumer -p execution-leaf
```

The independent full baseline is the original workflow's `cargo test`. Both receive the same offline environment. Healthy and restored runs have 6 selected versus 9 full Rust tests. Each injected production fault causes the expected runtime test failure and exit 101 in both modes; launch, timeout and compilation errors do not count as detection.

The test also verifies unchanged inputs and lockfile, clean committed state, explicit named targets, and refusal of inherited Git directory/index redirection before fixture initialization. CI sets `DIFFCI_REQUIRE_CARGO=1`, so missing Cargo, rustc or rustdoc cannot silently skip this proof.

Reproduce with Git and the Rust toolchain installed:

```sh
npm ci
DIFFCI_REQUIRE_CARGO=1 node --import tsx --test tests/repo/rust-execution.test.ts
DIFFCI_REQUIRE_CARGO=1 npm test
```

## Public repository replay

The existing pinned [glob replay](2026-11-10-rust-glob-replay.md) was also repeated on Linux, using Core head `aeca26ee6a661aab6e639bb095ccecbc8fd624d0`. The subsequent changes add test coverage, a mandatory-toolchain CI flag and reports; the Rust engine and replay harness are unchanged.

All three historical revisions again retained FULL validation and passed their full offline/locked Cargo baselines. Each ran 18 unit tests, 1 integration test and 5 doctests successfully, with 2 doctests ignored by glob itself. No public selective command was executed.

## Limits and next evidence

This tests Git analysis through Core's graph/planner to Cargo execution. It does not test an installed CLI against the new adapter. The workspace is synthetic, and three seeded faults do not establish zero false negatives. Cargo stops after failures, so mutation cases demonstrate detection rather than completion of every affected test after failure.

The public replay demonstrates safe fallback, not useful public-project narrowing. A bounded source-only search found no verified public workspace meeting all current gates; missing public inputs, external dependencies and unsupported invocation context remain real limitations. No inputs were fabricated, repositories modified to fit, or fallbacks weakened to obtain a selective result.

No wall-time, avoided-compute or production-savings claim is made.
