# DiffCI change impact

Shows which tests and checks a pull request affects, and why, in every Azure Pipelines run. Built for
teams whose pull requests come from AI coding agents as well as people.

```yaml
steps:
  - checkout: self
    fetchDepth: 0
  - task: UseNode@1
    inputs:
      version: "22.x"
  - task: DiffCIObserve@1
```

The summary appears in the run's **Extensions** tab, and the JSON report is kept as the
`diffci-observation` artifact.

**Observation only.** It runs nothing, skips nothing, changes nothing and sends nothing. A DiffCI
problem ends the step "succeeded with issues"; it never becomes the pipeline's result. Your required
tests keep running as they do today.

**Output variables** (`status`, `fullSuiteRequired`, `affectedTests`, `affectedTestCount`,
`totalTestCount`, `reason`) let later steps read the result. `fullSuiteRequired` is `"false"` only when
DiffCI narrowed the change cleanly, so anything that narrows on it falls back to the full suite whenever
DiffCI is unsure.

DiffCI is open source (MIT): [github.com/DiffCI/core](https://github.com/DiffCI/core).
