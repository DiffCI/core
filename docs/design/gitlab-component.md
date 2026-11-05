# Design: GitLab CI/CD component

Status: phase 0 shipped in CLI 0.3.26; phase 1 shipped in CLI 0.3.28, listed in the GitLab CI/CD Catalog, and run on a GitLab test project with 0.3.29 (2026-11-05, see [First GitLab run](#first-gitlab-run-2026-11-05)). This is the GitLab version of the observer Action (`action.yml`,
[github-action-observer.md](../github-action-observer.md)). It is the first integration outside GitHub.

## Goal

A GitLab project can add DiffCI to its pipeline in four lines and get the same observation report
that GitHub users get from `DiffCI/core@<release>`:

```yaml
include:
  - component: $CI_SERVER_FQDN/diffci/diffci/observe@0.3.29
```

What this does not do (same as the Action): it does not skip, cancel or reorder jobs, comment on
merge requests, or change the pipeline result. Enforcement on GitLab comes later, in phase 3.

Done means:

1. The component is listed in the GitLab CI/CD Catalog and is released by the same CI run that
   releases the CLI.
2. On a GitLab test project, merge-request, default-branch push and new-branch pipelines each produce
   `OBSERVED` with the correct range. The component does not run on schedule, web or API pipelines;
   run by hand there, the CLI uses HEAD^ and records `syntheticTrigger`, as it does for a GitHub schedule.
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
| `workflow` | `CI_CONFIG_PATH` |
| `job` | `CI_JOB_NAME` |
| `event` | `CI_PIPELINE_SOURCE` |
| `ref` | `CI_COMMIT_REF_NAME` |
| `syntheticTrigger` | `CI_PIPELINE_SOURCE` in `schedule`, `web`, `api`, `trigger`, `pipeline`, `parent_pipeline`, `chat`, `webide` |

`resolveCommitRange` gets a GitLab branch. It has the same traps as GitHub, under different names:

| Pipeline | Range | Trap |
|---|---|---|
| Merge request (`merge_request_event`) | base `CI_MERGE_REQUEST_DIFF_BASE_SHA`, head `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` (fall back to `CI_COMMIT_SHA` only when the source SHA is empty) | In merged-results pipelines `CI_COMMIT_SHA` is a merge commit GitLab created, the same trap as GitHub's merge ref. Diff the source branch head, not HEAD. `CI_COMMIT_BEFORE_SHA` is all zeros in MR pipelines, so never read it here. |
| Branch push (`push`) | base `CI_COMMIT_BEFORE_SHA`, head `CI_COMMIT_SHA` | All zeros on the first push to a new branch. Use the existing merge-base-with-default-branch logic, or `head-parent`, as GitHub does. |
| Anything synthetic | HEAD^..HEAD, `syntheticTrigger: true` | Same as a GitHub `schedule` today, which is not refused. The component's `rules` keep it off these pipelines. |

As built, the existing `source` values are reused (`pull-request-event`, `push-event`, `head-parent`).
`ci.provider` already says which provider produced the range, and new values would ripple into
Cloud's merge-gate code for no gain.

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

As built: [`integrations/gitlab/templates/observe/template.yml`](../../integrations/gitlab/templates/observe/template.yml),
with its [README](../../integrations/gitlab/README.md). `scripts/check-agent-packaging.mjs` fails
when its `cli-version` default or README example differs from the CLI package version, as it does
for `action.yml`.

Choices that differ from the Action, and why:

- **Sends nothing (`--no-send`), with no `api-url` or `api-token` input.** Cloud accepts GitHub
  repositories only, so a GitLab report has nowhere to go yet. When it does, the token must come
  from a masked, protected CI/CD variable, never an input: inputs are interpolated into the
  pipeline config, so a token passed as one would sit in plain text in the merged YAML.
- **`DIFFCI_STATUS` through a dotenv report**, in place of the Action's `status` output, so later
  jobs that `needs` the observer can read it.
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
| 1. Observer | Context (section 1), report copy, the component, the catalog project, the release step. Done 2026-11-05: context, report copy, component and packaging check; the public catalog project `gitlab.com/diffci/diffci`; its tag pipeline (`integrations/gitlab/.gitlab-ci.yml`); the `publish-gitlab-component` release job with its deploy-key preflight (`DIFFCI_GITLAB_DEPLOY_KEY`, a write deploy key; project access tokens need Premium on GitLab.com); catalog version 0.3.28; and the first GitLab run below. Tests in `context.test.ts` for each row of the range table, merged-results pipeline included. | "Done means" 1–3 on a GitLab test project. |
| 2. GitLab pipeline inference | Parse `.gitlab-ci.yml` in `src/ci-inference`: `include`, `extends`, `!reference`, `needs`, `rules:changes`, `parallel:matrix`. Then affected checks and the pipeline-impact plan work for GitLab repositories. | `plan` on a few public GitLab repositories names their real jobs, with blockers where config is dynamic. |
| 3. Enforcement | GitLab has a native way to run only some jobs: a job writes a generated child pipeline and a `trigger: include: artifact:` job runs it. DiffCI writes the child pipeline from its plan and falls back to the full parent pipeline on any blocker. GitHub has no equivalent, so this could be the strongest enforcement integration DiffCI has. | A design partner on GitLab keeps it on. |

The Alliance Partner application comes after phase 1, with the catalog listing and a replay result
as evidence. Phases 2 and 3 wait for a GitLab design partner, under the same rule as any other
expansion in the strategy.

## First GitLab run (2026-11-05)

`jshttp/cookie` (MIT, a Stage 0 repository, Vitest, 4 spec files) imported into the private project
`gitlab.com/diffci/observer-test-cookie`, with the four-line `include:` of `observe@0.3.29` on gitlab.com
shared runners, with no dependency install. Each observer job took 34–40 s.

| Check | Pipeline | Result |
|---|---|---|
| Push to the default branch changing `.gitlab-ci.yml` | 3031565112 | `OBSERVED`, event `push`, range `ddd20eb..c413958`, graph `COMPLETE`, FULL with "CI workflow definition(s) changed" ("done means" 3) |
| Pushes to two non-default branches | none | No pipeline, as the component's `rules` intend |
| Merge request !2, spec-only change | 3031568952 | `OBSERVED`, event `merge_request_event`, range `c413958..b5fe441` (target tip to source head), SELECTIVE: 1 of 4 specs (`src/stringify-cookie.spec.ts`) |
| Merge request !3, `src/index.ts` change | 3031569095 | `OBSERVED`, event `merge_request_event`, range `c413958..c2e11e1`, SELECTIVE: 4 of 4 specs, since every spec imports `src/index.ts` |
| Merge of !2 (default-branch push) | 3031572211 | `OBSERVED`, event `push`, range `c413958..07fb145`, SELECTIVE: 1 of 4 specs |

"Done means" 1–3 hold, and every selective plan had no fallback reason. Two findings:

- **0.3.28 planned FULL on every change** because its bundled TypeScript (5.9.3) rejected the repository's
  TS 6 options (`"target": "es2025"`, `"lib": ["es2025"]`) and marked the graph `UNSAFE`. Core a5f1c26
  (CLI 0.3.29) ignores that diagnostic when the project sets `module` or `moduleResolution`, which is
  what turned this run selective. The 0.3.28 pipelines (3031262663, 3031284067, 3031290187) are in the
  same project.
- The merge request range reports `source: "pull-request-event"`, GitHub's term, on GitLab.

The publish path also found three release problems, all fixed: a deploy key with a passphrase (generate
it in Git Bash; PowerShell drops `-N ""`), GitLab account verification before any pipeline runs, and a
422 on the catalog release from invalid component YAML (`tests/gitlab-component.test.ts` now parses it).

## Open questions

1. **Namespace.** Settled: `gitlab.com/diffci` is DiffCI's group.
2. **Self-managed GitLab.** Components work on self-managed instances, but the catalog is per
   instance. Document "copy the project" for now; not a release goal.
