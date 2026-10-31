# Public roadmap

This is an evaluation roadmap, not a delivery guarantee. Existing support limits are in [release-boundary.md](release-boundary.md).

| Milestone | Completion evidence |
| --- | --- |
| Make local trials easy | One-command CLI trial, clear fallback interpretation, contribution setup |
| Recruit five assisted pilots | Maintainer consent, exact revision pairs, declared measurement protocol |
| Publish two reproducible pilot stories | Raw reports, repeated timings, analysis overhead, limitations |
| Expand regression fixtures | Bounded issues with positive and fallback cases |
| Publish a benchmark roundup | Denominator includes failures, refusals and regressions; distinguish static selection from runtime |

## Language support

JS/TS, Vue, Go and Maven are supported today. Python, Rust and Gradle are next and open for contributors; each tracking issue lists small steps that are one PR each:

- [Python (pytest)](https://github.com/DiffCI/core/issues/61)
- [Rust (Cargo)](https://github.com/DiffCI/core/issues/62)
- [Gradle (Java/Kotlin)](https://github.com/DiffCI/core/issues/68)

Want another language? 👍 an existing tracking issue or open one with the `adapter` label. Reactions decide what comes next.

Watch → Custom → Releases and Discussions to follow published results and support changes. Release notes should state changed support boundaries, new fallback cases, and measured improvements only when artifacts exist. Aim to publish a monthly benchmark report; a month with no new measurements should say so explicitly.

Monthly reports should start from the [benchmark report template](benchmark-report-template.md), which keeps unsuccessful attempts in the denominator and separates static selection, measured runtime, and modeled impacts.
