# DiffCI change impact for Azure Pipelines

`DiffCIObserve@1` is the Azure Pipelines version of the [GitHub Action](../../action.yml) and the
[GitLab component](../gitlab/README.md). It runs `diffci observe --no-send` on the pipeline's checkout,
shows the summary in the run's **Extensions** tab, and keeps the report as a pipeline artifact.
Observation only: it runs no tests and never decides the pipeline's result.

```yaml
steps:
  - checkout: self
    fetchDepth: 0          # DiffCI compares against the pull request's base commit
  - task: UseNode@1        # the CLI runs through npx, which the agent's own Node does not provide
    inputs:
      version: "22.x"
  - task: DiffCIObserve@1
    name: diffci
  - script: echo "full suite needed: $(diffci.fullSuiteRequired)"
```

## What it compares

The CLI works the range out from the pipeline (`packages/diffci-cli/src/client/context.ts`):

- **Pull request builds** check out a merge commit. DiffCI compares the merge base of the target branch and
  the source head (`System.PullRequest.SourceCommitId`) up to that head.
- **CI builds** (`IndividualCI`, `BatchedCI`) carry no "before" commit, so DiffCI describes the last
  commit against its parent.
- **Manual and scheduled builds** have no change of their own; they are recorded as such.

When the checkout is shallow and the base commit is missing, DiffCI tries to fetch the history and
otherwise refuses with a message saying to set `fetchDepth: 0`. It never guesses a range.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `repositoryPath` | `$(Build.SourcesDirectory)` | The checkout to observe |
| `cliVersion` | the release this task shipped with | Exact `@diffci.com/diffci` version |
| `redactPaths` | `false` | Replace file paths in the report with digests |
| `uploadArtifact` | `true` | Keep the report and summary as an artifact |
| `artifactName` | `diffci-observation` | Artifact name |
| `failOnError` | `false` | Fail the step on a refusal or error (debugging only) |

## Notes for maintainers

- The task has no dependencies and writes logging commands itself. It declares no restricted command
  mode, because restricted mode refuses `task.uploadsummary` and `artifact.upload`.
- `task.json` declares the `Node24` and `Node20_1` handlers.
- The extension version equals the CLI version; the task version is `1.<CLI minor>.<CLI patch>`.
  `npm run agent:check` fails when they drift from `packages/diffci-cli/package.json`.
- Package locally with `npx tfx-cli extension create --root integrations/azure-devops --output-path <dir>`.
  Publishing (a private `diffci-dev` extension first) is not wired into the release yet.
