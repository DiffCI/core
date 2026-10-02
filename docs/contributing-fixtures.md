# Contribute a fixture

Use synthetic code rather than customer code. Copy the `fixture(files)` and `delta(path)` pattern from `tests/repo/language-adapters.test.ts`, or the nearest regression suite for the behavior you are testing.

Fixture submission template:

```text
Supported runner/language and version:
Minimal file tree and contents:
Changed file and base/head delta:
Expected affected tests:
Expected fallback or command refusal:
Actual result and reproduction command:
```

A good fixture contains a changed source, an importing test, and an unrelated test. Include transitive imports if relevant. Assert membership and fallback reasons, rather than incidental node order or timing. Unsupported configuration must produce uncertainty/full fallback, never an empty successful selection. Always remove temporary directories in `finally`.

For a public-repository pilot, record the repository URL, base/head SHAs, DiffCI version, exact commands, environment, cache preparation, repetitions, raw reports, and limitations. Selection count is not measured savings. Do not claim zero false negatives from passing commands alone; include failure assessment and the scope of validation.
