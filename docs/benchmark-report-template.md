# DiffCI benchmark roundup — YYYY-MM

> Template instructions: replace every `<placeholder>`, remove unused optional rows without changing the denominator, and link the immutable raw artifacts. A month with no completed measurements should say so. Do not turn static selection counts, modeled values, or sandbox timings into production-savings claims.

## Scope and headline

- Reporting period: `<start date>` through `<end date>`
- Protocol version or commit: `<URL and immutable SHA>`
- DiffCI versions evaluated: `<exact versions>`
- Repositories attempted: `<count>`
- Frozen repository/revision pairs attempted: `<count>`
- Completed paired measurements: `<count>`
- Headline: `<measured result, negative result, or “no completed runtime measurements”>`
- Claim boundary: `<test stage, job-equivalent sandbox, or no runtime claim>`

State who selected the repositories and revisions, when the selection rule was frozen, whether maintainers consented to publication, and whether any candidate was added, removed, or replaced after results were known.

## Denominator accounting

Count each frozen repository/revision pair exactly once by its final disposition. The total row must equal the announced attempted-pair denominator.

| Final disposition | Pairs | Definition |
| --- | ---: | --- |
| Completed paired selective measurement | `<n>` | Full and selected arms completed under the declared repetition protocol. |
| Completed full-fallback measurement | `<n>` | DiffCI retained full validation; any measured overhead is reported, with zero gross test savings. |
| Command or analysis refusal | `<n>` | DiffCI could not produce an executable selected command or refused the analysis. |
| Execution failure | `<n>` | Analysis completed, but at least one required execution could not produce valid comparable evidence. |
| Provenance invalidation | `<n>` | Revision, checkout, artifact, environment, or command identity could not be verified. |
| **Total attempted pairs** | **`<n>`** | Must equal the sum above. |

Also report the repository-level denominator when a repository contributes multiple revision pairs: `<attempted repositories>; <repositories with at least one valid paired result>; <repositories with none>`.

## Frozen revision pairs and provenance

| Pair ID | Repository | Base SHA | Head SHA | Selection reason frozen before execution | Maintainer publication consent | Final disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `<repo-01-pair-01>` | `<public URL or consented alias>` | `<full SHA + link>` | `<full SHA + link>` | `<rule or manifest row>` | `<basis and date>` | `<one denominator category>` |

Record redirects, force-pushes, missing objects, dirty checkouts, head mismatches, changed lockfiles, and any other provenance problem. Keep invalidated rows in this table and link their evidence.

## Reproduction protocol

- Runner or machine: `<OS, architecture, CPU allocation, memory>`
- Runtime and package manager: `<exact versions>`
- Install command: `<exact command>`
- Full command: `<exact command>`
- Selected command source: `<raw DiffCI report field or “unavailable”>`
- DiffCI command: `<exact command with explicit base/head>`
- Cache preparation: `<command and state prepared before every arm>`
- Repetitions: `<at least three for a controlled runtime claim>`
- Arm order: `<for example FULL→SELECTED, SELECTED→FULL, FULL→SELECTED>`
- Timeout and resource limits: `<values>`
- Clock and process measurement: `<method>`
- Warm-up, retries, and failure policy: `<predeclared rules>`

Alternating order is required for a controlled paired claim. Do not silently rerun or replace an unfavorable, flaky, refused, or timed-out attempt. If no selected command exists, say that alternation was not applicable and make no paired runtime claim.

## Static selection evidence

Static analysis is not runtime evidence. Report it independently even when execution is impossible.

| Pair ID | Analysis status | Mode | Selected / discovered tests | Graph confidence | Fallback reasons | Command synthesis | Raw observation |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| `<id>` | `<status>` | `<SELECTIVE/FULL>` | `<n / n>` | `<value>` | `<verbatim reasons>` | `<command or refusal>` | `<link>` |

Do not convert the selected-test fraction into time, cost, carbon, or correctness savings. A passing selected command does not prove that omitted tests could never fail.

## Runtime evidence

List every attempted repetition, including failures. Durations are wall-clock unless explicitly labeled otherwise.

| Pair ID | Repetition | Order | Cache preparation | Analysis ms | Full ms / result | Selected-or-policy ms / result | Valid pair? | Raw artifacts |
| --- | ---: | --- | --- | ---: | --- | --- | --- | --- |
| `<id>` | `1` | `FULL→SELECTED` | `<result>` | `<ms>` | `<ms, pass/fail/timeout>` | `<ms, pass/fail/timeout/refused>` | `<yes/no + reason>` | `<logs and JSON>` |
| `<id>` | `2` | `SELECTED→FULL` | `<result>` | `<ms>` | `<...>` | `<...>` | `<...>` | `<...>` |
| `<id>` | `3` | `FULL→SELECTED` | `<result>` | `<ms>` | `<...>` | `<...>` | `<...>` | `<...>` |

Summarize distributions without deleting unsuccessful attempts:

| Pair ID | Valid / attempted repetitions | Full median (range) | Policy median (range) | Median analysis overhead | Net effect including analysis | Claim status |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `<id>` | `<n / n>` | `<ms (min–max)>` | `<ms (min–max)>` | `<ms>` | `<ms and %, or unavailable>` | `<controlled/preliminary/none>` |

For repetition `i`, define `net_i = full_i - policy_i - analysis_i` unless the declared protocol already includes analysis in the policy duration. State the convention once and do not double-subtract. Aggregate only predeclared valid pairs, and show excluded failures in the attempt table. For full fallback, `policy_i` is the full command, gross test savings are zero, and analysis is net overhead.

## Refusals, failures, fallbacks, and invalidations

| Pair ID / attempt | Category | Stage | Verbatim reason or failing command | Included in which denominator | Next diagnostic |
| --- | --- | --- | --- | --- | --- |
| `<id>` | `<refusal/failure/full fallback/provenance invalidation>` | `<stage>` | `<reason>` | `<pair and/or repetition>` | `<reproducible next check>` |

Explain whether each failure appears pre-existing, tool-induced, flaky, or unresolved. Do not reclassify an unsuccessful attempt as a warm-up after seeing its result.

## Modeled cost, energy, and carbon (optional)

Keep measured inputs separate from modeled outputs. Omit this section when assumptions are unavailable.

### Measured inputs

| Input | Value | Scope | Artifact |
| --- | ---: | --- | --- |
| Runner wall time | `<seconds>` | `<job/stage/process>` | `<link>` |
| CPU time or utilization | `<value or unavailable>` | `<scope>` | `<link>` |

### Caller-supplied assumptions and modeled outputs

| Quantity | Value | Basis / source | Classification |
| --- | ---: | --- | --- |
| Runner price | `<currency per unit>` | `<dated source>` | Assumption |
| Power draw | `<watts>` | `<source or estimate>` | Assumption |
| Grid intensity | `<gCO2e/kWh>` | `<region, date, source>` | Assumption |
| Modeled cost difference | `<value>` | `<formula>` | Modeled, not measured |
| Modeled energy difference | `<value>` | `<formula>` | Modeled, not measured |
| Modeled carbon difference | `<value>` | `<formula>` | Modeled, not measured or verified avoided emissions |

Do not label modeled cost, energy, or carbon as measured. Preserve negative modeled results and sensitivity ranges.

## Raw artifact index

| Artifact | Pair / attempt | Contents | SHA-256 | Immutable link |
| --- | --- | --- | --- | --- |
| `<filename>` | `<id>` | `<observation, timing report, stdout, stderr, environment, or manifest>` | `<hash>` | `<link>` |

Include the selection manifest, exact commands, environment record, raw observations, execution logs, timing reports, and checksums. State any redaction and why it does not change the reported result.

## Limitations

- `<repository and revision coverage>`
- `<test surface not modeled or executed>`
- `<runner/environment differences from production>`
- `<cache and order effects not controlled>`
- `<sample size and statistical limits>`
- `<correctness claims that the experiment cannot establish>`
- `<known conflicts of interest, including self-evaluation>`

## Next reproducible questions

List concrete follow-ups whose answer can be falsified with another frozen run. For example:

1. `<Does command synthesis succeed after adding support for the repository's declared runner?>`
2. `<Does the net result remain positive under the reverse execution order on the same revision pair?>`
3. `<Does a full-fallback reason disappear without changing the selected test inventory?>`
4. `<Can an independent maintainer reproduce the artifact checksums and outcome?>`

## Conclusion

State what was measured, what was only modeled, what failed or was refused, and what cannot be claimed. If no pair supports a controlled runtime claim, say so plainly.
