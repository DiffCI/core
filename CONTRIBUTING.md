# Contributing

Start with a [good first issue](https://github.com/DiffCI/core/issues?q=is%3Aopen+label%3A%22good+first+issue%22). A fixture, fallback explanation, or reproducible benchmark is a useful contribution without learning the whole engine.

Fork Core, clone your fork, and create a branch. A Node 22 development container is available in `.devcontainer/devcontainer.json`; alternatively install Node.js 22.5+ locally. `npm ci` installs dependencies and builds Core. Use [the fixture checklist](docs/contributing-fixtures.md) for regressions and [the adapter tutorial](docs/adding-an-adapter.md) for framework support.

In your PR, explain the changed behavior, include the reproducible fixture and validation results, and identify unsupported cases. Small documentation contributions do not need new tests. Safety and planning changes do.

Open an issue or pull request describing the behavior and a reproducible example. Do not post credentials, customer source, private logs or other confidential data.

Use Node.js 22.5+ and run `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and `npm run audit:boundary`. Changes to safety or planning should include a regression test using a synthetic repository. Preserve full-run fallback on insufficient evidence; distinguish advisory selection from executable commands.

Contributions to this repository are made under the MIT License. Submit only work you are entitled to contribute and preserve third-party notices.

Sign off every commit to certify the [Developer Certificate of Origin](https://developercertificate.org/), using `git commit -s`. This adds a `Signed-off-by: Your Name <you@example.com>` line stating that you wrote the change or otherwise have the right to submit it under the MIT License.

## Credit

Every merged contribution is credited by name: in the release notes of the version that ships it, in the [Contributors](README.md#contributors) list in the README, on [diffci.com/contributors](https://diffci.com/contributors), and next to the feature in the docs when it adds one. Tell us in your PR if you would like a different name or link used, or would rather not be listed on diffci.com.

## Contributor tiers

Contributors who keep coming back get more say in DiffCI, not just more credit. There are three tiers. Each one includes everything in the tiers below it.

| Tier | How you get there | What it gives you |
| --- | --- | --- |
| **Contributor** | One merged pull request. | Credit in the release notes, the README and the docs, as described above. |
| **Regular contributor** | Several merged pull requests over more than a few days, and an invitation from a maintainer. | Listed as a regular contributor in the README. First pick of new issues: you can ask for an issue to be assigned to you before it is labelled `good first issue`. Asked for input on design issues before work starts. A written reference or LinkedIn recommendation describing your DiffCI work, on request. |
| **Area maintainer** | Sustained work on one area, such as an adapter or the lockfile signals, and an invitation from a maintainer. | Named as the maintainer of that area in the README and the area's docs. You are consulted on design decisions in your area and requested as a reviewer on pull requests that touch it. Co-authorship, under your own name, of the write-up or benchmark when your area ships. First in line for paid milestone bounties once [sponsorship](https://github.com/sponsors/DiffCI) funds them. |

Tiers are offered, not applied for. A maintainer will invite you when your work fits a tier, and you can decline or step back at any time without losing credit for what you did. Inactive maintainers move to an emeritus list and keep their credit. No tier comes with merge or triage rights on the repository: those stay with the DiffCI maintainers.

Every tier works under the same rules: the [stewardship commitments](STEWARDSHIP.md), the DCO sign-off and full-suite fallback on insufficient evidence.
