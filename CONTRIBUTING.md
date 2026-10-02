# Contributing

Start with a [good first issue](https://github.com/DiffCI/core/issues?q=is%3Aopen+label%3A%22good+first+issue%22). A fixture, fallback explanation, or reproducible benchmark is a useful contribution without learning the whole engine.

Fork Core, clone your fork, and create a branch. A Node 22 development container is available in `.devcontainer/devcontainer.json`; alternatively install Node.js 22.5+ locally. `npm ci` installs dependencies and builds Core. Use [the fixture checklist](docs/contributing-fixtures.md) for regressions and [the adapter tutorial](docs/adding-an-adapter.md) for framework support.

In your PR, explain the changed behavior, include the reproducible fixture and validation results, and identify unsupported cases. Small documentation contributions do not need new tests. Safety and planning changes do.

Open an issue or pull request describing the behavior and a reproducible example. Do not post credentials, customer source, private logs or other confidential data.

Use Node.js 22.5+ and run `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and `npm run audit:boundary`. Changes to safety or planning should include a regression test using a synthetic repository. Preserve full-run fallback on insufficient evidence; distinguish advisory selection from executable commands.

Contributions to this repository are made under AGPL-3.0-only. Submit only work you are entitled to contribute and preserve third-party notices. This policy does not grant DiffCI permission to relicense other contributors' work under proprietary terms; any additional licensing agreement must be handled separately.
