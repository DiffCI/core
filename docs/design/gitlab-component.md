# Design: GitLab CI/CD component

Status: proposal (2026-11-05). This is the GitLab version of the observer Action (`action.yml`,
[github-action-observer.md](../github-action-observer.md)). It is the first integration outside GitHub.

## Goal

A GitLab project can add DiffCI to its pipeline in four lines and get the same observation report
that GitHub users get from `DiffCI/core@<release>`:

```yaml
include:
  - component: gitlab.com/diffci/diffci/observe@0.3.25
```

What this does not do (same as the Action): it does not skip, cancel or reorder jobs, comment on
merge requests, or change the pipeline result. Enforcement on GitLab comes later, in phase 3.

Done means:

1. The component is listed in the GitLab CI/CD Catalog and is released by the same CI run that
   releases the CLI.
2. On a GitLab test project, merge-request, default-branch push and new-branch pipelines each produce
   `OBSERVED` with the correct range. Schedule, web and API pipelines produce `REFUSED` with a reason.
3. A change to `.gitlab-ci.yml` or to a file it includes never gets a selective plan.

## What has to change in Core first

The CLI only knows GitHub today. Running it unchanged on GitLab would resolve the wrong range or
refuse, so these come before the component.

### 1. CI context (`packages/diffci-cli/src/client/context.ts`)

`readCiEnvironment` returns `provider: "unknown"` on GitLab, because it only checks
`GITHUB_ACTIONS`. Add a `"gitlab-ci"` provider, detected by `GITLAB_CI === "true"`:

| `CiEnvironmentFacts` field | GitLab variable |
|---|---|
| `ownerName` | `CI_PROJECT_PATH` |
| `providerRepositoryId` | `CI_PROJECT_ID` |
| `defaultBranch` | `CI_DEFAULT_BRANCH` |
| `runId` | `CI_PIPELINE_ID` |
| `job` | `CI_JOB_NAME` |
| `event` | `CI_PIPELINE_SOURCE` |
| `ref` | `CI_COMMIT_REF_NAME` |
| `syntheticTrigger` | `CI_PIPELINE_SOURCE` in `schedule`, `web`, `api`, `trigger`, `pipeline`, `chat` |

`resolveCommitRange` gets a GitLab branch. It has the same traps as GitHub, under different names:

| Pipeline | Range | Trap |
|---|---|---|
| Merge request (`merge_request_event`) | base `CI_MERGE_REQUEST_DIFF_BASE_SHA`, head `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` (fall back to `CI_COMMIT_SHA` only when the source SHA is empty) | In merged-results pipelines `CI_COMMIT_SHA` is a merge commit GitLab created, the same trap as GitHub's merge ref. Diff the source branch head, not HEAD. `CI_COMMIT_BEFORE_SHA` is all zeros in MR pipelines, so never read it here. |
| Branch push (`push`) | base `CI_COMMIT_BEFORE_SHA`, head `CI_COMMIT_SHA` | All zeros on the first push to a new branch. Use the existing merge-base-with-default-branch logic, or `head-parent`, as GitHub does. |
| Anything synthetic | none | Refuse with "no change to analyse", as GitHub `schedule` does. |

Use new `source` values (`merge-request-pipeline`, `push-pipeline`) so a receipt says which
provider produced its range.

`DEEPEN_HINT` names `actions/checkout`. Make it depend on the provider. On GitLab the fix is
`GIT_DEPTH: 0` on the DiffCI job. GitLab clones with a shallow depth of 20 by default, so a long
merge request can lose its base. The component sets this itself (see below); the hint covers
people who copy the job by hand.

### 2. Recognising GitLab CI config as global risk

Changes under `.github/workflows/` force a full run in three places: `src/git/git-diff.ts:465`
(`workflow` signal), `src/planner/path-baseline.ts:148` and `GLOBAL_RISK_PATTERNS` in
`packages/diffci-cli/src/client/enforce-policy.ts`. None of them knows `.gitlab-ci.yml`.

Check before anything else: on a fixture, does a change to `.gitlab-ci.yml` alone currently
produce a selective plan? If yes, that is a safety bug for GitLab users of `verify` today and ships
on its own, ahead of the component.

Then treat these as workflow files:

- `.gitlab-ci.yml`, or the custom path in `CI_CONFIG_PATH` when it is set
- any local file named by `include: local:` (and `include:` string shorthand) in those files.
  Until includes are parsed (phase 2), any `.yml`/`.yaml` under `.gitlab/` or `ci/` counts.
- `.gitlab/ci/**`, the usual convention

### 3. Report location

The CLI already defaults to `tmpdir()` when `RUNNER_TEMP` is missing. That is `/tmp` in GitLab job
images, which is outside `CI_PROJECT_DIR`, so the clean-tree rule holds. But GitLab artifacts must
be inside `CI_PROJECT_DIR`. So the component writes the report to `/tmp` and copies it into
`$CI_PROJECT_DIR/.diffci/` only after the observer has finished. That is safe because the copy
happens at the end of a job that only runs DiffCI, and GitLab runners `git clean` the checkout
between jobs.

### 4. `diffci init`

`workflow-templates.ts` writes GitHub workflows only. Add a GitLab template, used when the repository
has a `.gitlab-ci.yml` and no `.github/workflows/`, that adds the `include:` line above. It is not
needed for the first release.

## The component

### Where it lives

The GitLab CI/CD Catalog only lists projects hosted on GitLab. So:

- Source stays in Core at `integrations/gitlab/templates/observe/template.yml`, reviewed and
  versioned with everything else.
- A small dedicated project `gitlab.com/diffci/diffci` holds `templates/`, a `README.md` and a
  release job. That is all the catalog needs, without mirroring the whole Core history.
- Core's release workflow pushes `integrations/gitlab/` to that project and tags it with the CLI
  version. The tag pipeline there creates the GitLab release that publishes the catalog version.
  Add the GitLab push to the existing release manifest so a version bump can't skip it.

The component version equals the CLI version it pins, like `cli-version` in `action.yml`. One
number means one thing.

### Template

```yaml
spec:
  inputs:
    stage:
      default: test
    job-name:
      default: diffci-observe
    image:
      default: node:22          # Debian-based: has git and bash. Alpine images have neither.
    cli-version:
      default: "0.3.25"
    redact-paths:
      type: boolean
      default: false
    api-url:
      default: ""
    artifact-expire-in:
      default: 7 days
---
"$[[ inputs.job-name ]]":
  stage: $[[ inputs.stage ]]
  image: $[[ inputs.image ]]
  needs: []                     # start at once; depend on nothing and block nothing
  allow_failure: true
  variables:
    GIT_DEPTH: "0"
    DIFFCI_CLI_VERSION: $[[ inputs.cli-version ]]
    DIFFCI_REDACT: $[[ inputs.redact-paths ]]
    DIFFCI_API_URL: $[[ inputs.api-url ]]
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
  script:
    - |
      set -euo pipefail
      # exact-semver check, same regex as action.yml
      out="$(mktemp -d)/diffci-observation.json"
      args=(observe --repo "$CI_PROJECT_DIR" --out "$out")
      if [ "$DIFFCI_REDACT" = "true" ]; then args+=(--redact-paths); fi
      (cd /tmp && npx --yes --ignore-scripts --no-audit --fund=false \
        --package "@diffci.com/diffci@$DIFFCI_CLI_VERSION" diffci "${args[@]}")
      mkdir -p "$CI_PROJECT_DIR/.diffci" && cp "$out" "$CI_PROJECT_DIR/.diffci/"
  artifacts:
    when: always
    expose_as: DiffCI observation  # shows a link in the merge request widget
    paths: [.diffci/]
    expire_in: $[[ inputs.artifact-expire-in ]]
```

Choices that differ from the Action, and why:

- **No `api-token` input.** Inputs are interpolated into the pipeline config, so a token passed as
  an input would sit in plain text in the merged YAML. The CLI reads `DIFFCI_TOKEN` from the
  environment, so users set it as a masked, protected CI/CD variable. Nothing is sent unless both
  `api-url` and that variable are set, as on GitHub.
- **No `fail-on-error` input.** `allow_failure: true` already keeps a DiffCI problem from failing
  the pipeline. Someone debugging can override the job with `allow_failure: false`.
- **`rules` are built in** so the job runs only where a range exists, and doesn't run twice when a
  project has both branch and MR pipelines. Projects can override `rules` on the job name.
- **Pin `image` by digest in the docs example**, as the Action pins its actions by SHA. The default
  stays a tag so the catalog example is readable.

## Phases

| Phase | Work | Check before the next phase |
|---|---|---|
| 0. Safety | The `.gitlab-ci.yml` fallback check and fix (section 2). Ship on its own. | A fixture that changes only `.gitlab-ci.yml` runs the full suite in `plan`, `verify` and enforce. |
| 1. Observer | Context (section 1), report copy, the component, the catalog project, the release step. Tests in `context.test.ts` for each row of the range table, merged-results pipeline included. | "Done means" 1–3 on a GitLab test project. |
| 2. GitLab pipeline inference | Parse `.gitlab-ci.yml` in `src/ci-inference`: `include`, `extends`, `!reference`, `needs`, `rules:changes`, `parallel:matrix`. Then affected checks and the pipeline-impact plan work for GitLab repositories. | `plan` on a few public GitLab repositories names their real jobs, with blockers where config is dynamic. |
| 3. Enforcement | GitLab has a native way to run only some jobs: a job writes a generated child pipeline and a `trigger: include: artifact:` job runs it. DiffCI writes the child pipeline from its plan and falls back to the full parent pipeline on any blocker. GitHub has no equivalent, so this could be the strongest enforcement integration DiffCI has. | A design partner on GitLab keeps it on. |

The Alliance Partner application comes after phase 1, with the catalog listing and a replay result
as evidence. Phases 2 and 3 wait for a GitLab design partner, under the same rule as any other
expansion in the strategy.

## Open questions

1. **Test project.** DiffCI has no GitLab repository of its own. Options: import DentalPresence into a
   private GitLab project, or import one of the Stage 0 public repositories. An import gives real
   history to replay against.
2. **Namespace.** Is `gitlab.com/diffci` free to register?
3. **Self-managed GitLab.** Components work on self-managed instances, but the catalog is per
   instance. Document "copy the project" for now; not a release goal.
