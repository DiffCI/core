# Rust public replay: anstyle, 2026-11-17

## Result

Three of four historical revisions of [rust-cli/anstyle](https://github.com/rust-cli/anstyle), a virtual workspace of 20 crates, got a **SELECTIVE** plan. At each of them the selected `cargo test` command ran next to the full baseline and reported the same failures (none), and a test that fails, injected into the changed file in a separate clone, failed in both runs. Two revisions ran a narrower command than the full run:

| Target head | Exact parent | Changed | Plan | Command crates | Tests run (full / selected) | Injected fault |
| --- | --- | --- | --- | --- | --- | --- |
| [`f9639e70cb43`](https://github.com/rust-cli/anstyle/commit/f9639e70cb43f456ab15f04446f4c80e2163f452), detect OSC 9;4 in tmux | `5a4a67f7b8358564fb9337f2955553f166ad57bd` | `crates/anstyle-progress/src/query.rs` | SELECTIVE, 4 of 25 test targets | 7 of 20 | 170 / 95 | caught by both |
| [`1c4609a7b3ac`](https://github.com/rust-cli/anstyle/commit/1c4609a7b3ac7cbe0fd60e3fb2b410db877758e0), escape link characters | `d234fa36798244f2f68c0b8d0f831d554d8cdc6d` | `crates/anstyle-svg/src/lib.rs` | SELECTIVE, 3 of 25 | 6 of 20 | 169 / 92 | caught by both |
| [`4e584086dc7b`](https://github.com/rust-cli/anstyle/commit/4e584086dc7bff99f20506999509af6f1add7440), Debug impls | `25e9c043e8b4af3c404df9f13a98b3366fdc4045` | `crates/anstyle-progress/src/progress.rs` | SELECTIVE, 2 of 25 | 18 of 20 | 168 / 164 | caught by both |
| [`d234fa367982`](https://github.com/rust-cli/anstyle/commit/d234fa36798244f2f68c0b8d0f831d554d8cdc6d), check bad link behavior | `52495ba9af66443ac177785307947f9fc86afbca` | `Cargo.lock`, `crates/anstyle-svg/Cargo.toml`, `crates/anstyle-svg/src/lib.rs` | FULL | all | full run only | — |

All four full baselines passed. Timings are in the [machine-readable report](2026-11-17-rust-anstyle-replay.json); they are single sequential observations with a shared build cache, so this is **not an avoided-compute claim**.

## Why the commands look the way they do

- The selected test targets are the changed crate's own targets and those of the crates that depend on it.
- A selected crate that would build a shared dependency (here `libc` or `rustix`) with fewer features than the full run gets the crates of the smallest Cargo feature unit that builds it the full run's way. That is why `4e584086dc7b` selects 2 test targets but runs 18 crates: the command is wider than the selection, but each dependency is built exactly as in the full run.
- `anstream` and `anstyle-parse` also appear as published versions among the workspace's dev-dependencies, so they are passed to Cargo as `anstream@1.0.0` and `anstyle-parse@1.0.0`.
- `d234fa367982` changes `Cargo.lock`, which is a runtime input outside crate metadata, so the plan stays FULL.

anstyle's own CI does not give plain `cargo test` invocation evidence, so the selected commands come from the same planner with the harness baseline (`cargo test --offline --locked`, no flags or compiler environment) as the evidence. The plan's own `commandSpecs` were empty, as they should be.

## Environment

- Core head `3654193e9aa3a8b0cc4794d7652587e15544e48d`, clean tracked tree.
- Official target history pinned beneath `46bb5c061b42ebad90694969352ee0a31d67fc68`, using anstyle's committed `Cargo.lock` at each head (hashes are in the report).
- Linux x64, Node `v24.22.1`, Cargo and rustc `1.100.0`.

## Reproduction

Run the `Rust public repository replay` workflow by hand with the `anstyle` target, or build Core (`npm ci`, `npm run build`), clone the official repository into a disposable directory, check out the pinned head and run:

```sh
node scripts/replay-rust.mjs --target anstyle \
  --repo /tmp/disposable-rust-replay/anstyle \
  --disposable-root /tmp/disposable-rust-replay \
  --output /tmp/rust-replay-report.json \
  --prepare-dependencies
```

The harness checks the official origin, pinned ancestry, exact parents and clean state, runs `cargo fetch --locked` (which refuses to change the committed lockfile), and checks that analysis and tests leave the checkout as they found it.

## What this does not show

One Linux toolchain and Cargo's default features only; anstyle's CI matrix, other platforms and feature sets are not reproduced. [servo/rust-url](https://github.com/servo/rust-url) was also tried: the plan narrowed (4 to 7 of 11 test targets), but Cargo feature unification widened every command to all six crates, its custom test harness interleaves output across parallel tests, and `form_urlencoded` does not run unit tests, so it is not a pinned target.
