# JUnit reporter fixtures

These XML files were emitted by real local runs of authored synthetic JavaScript tests on Node 24.11.1, using exactly:

- Vitest 5.1.0
- Jest 30.5.2 with jest-junit 17.0.0

Each run exited 1 because the fixtures deliberately fail. `source.json` contains every test file and both reporter configurations. No reporter dependency is needed to consume these saved files in the check-plan tests.

| File | Failed testcase elements | Conventions exercised |
| --- | ---: | --- |
| `vitest-default.xml` | 5 | Relative paths in classname/suite name, nested descriptions, duplicate names, skipped/todo cases, load and hook failures |
| `vitest-explicit.xml` | 5 | Explicit file attributes with custom non-path classname/suite labels |
| `jest-junit-default.xml` | 4 | Describe/test labels cannot identify files; load-failing suites are omitted by this default reporter configuration |
| `jest-junit-explicit.xml` | 6 | Explicit files and `reportTestSuiteErrors: 'true'`; the load error produces two failed cases; hook errors make actual failures exceed declared counts |

Both reporters emit two failure children for the one test in `multiple-errors.test.js`. That remains one failed testcase. The two tests named `duplicate name` remain two cases, even though their names and file identity match.

## Reproduce

Create an empty disposable directory, write a private `package.json` with the exact development dependencies from `source.json`, and write every entry of its `files` object at the corresponding path. Install with `npm install --ignore-scripts --no-audit --fund=false`.

Run these commands with `REPORTER_VARIANT=default`, then repeat with `REPORTER_VARIANT=explicit`:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.config.mjs
node node_modules/jest/bin/jest.js --ci --runInBand --config jest.config.cjs
```

Set that variable through the process environment on Windows. Remove inherited `JEST_JUNIT_*`, `JEST_SUITE_NAME`, `JEST_USE_PATH_FOR_SUITE_NAME` and `NODE_TEST_CONTEXT` variables so local settings do not override the captured configurations.

The raw outputs were normalized only to replace the disposable absolute directory with `/fixture`, replace the hostname with `synthetic-host`, fix timestamp attributes, set timing attributes to zero, and use LF newlines. Test identities, paths, XML structure, counters and failure messages otherwise retain reporter output. `provenance.json` records the raw and normalized SHA-256 hashes and the installation lockfile hash. These files document POSIX reporter execution; Windows and nested-XML path cases in the unit test are separately authored synthetic examples.

## Primary sources

- [Vitest 5.1.0 emitter](https://github.com/vitest-dev/vitest/blob/7a3844954d8753fc0d5bed76a96ffd3a21716c22/packages/vitest/src/node/reporters/junit.ts)
- [jest-junit 17.0.0 builder](https://github.com/jest-community/jest-junit/blob/20d8f149fcf7e03fd1a541e1d8d29ecf0a47fab6/utils/buildJsonResults.js)
- [jest-junit 17.0.0 defaults](https://github.com/jest-community/jest-junit/blob/20d8f149fcf7e03fd1a541e1d8d29ecf0a47fab6/constants/index.js)

In particular, jest-junit's default output cannot recover a filename from arbitrary describe labels, and it omits zero-test load failures unless configured to report them. Check-plan cannot recover an error absent from the supplied report.
