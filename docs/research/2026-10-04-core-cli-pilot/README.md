# DiffCI Core published-CLI self-evaluation (2026-10-04)

## Result

This is a reproducible negative result against the public [`DiffCI/core`](https://github.com/DiffCI/core) repository. DiffCI 0.3.2 consistently found a selective static impact set, but refused to construct a selected test command for Core's custom test harness. No full or selected test command was executed by `check`, no paired runtime distribution exists, and this report makes no CI-savings or production-savings claim.

The repository is controlled by the organization publishing this report. This is maintainer-authorized self-evaluation, not an independent external pilot or third-party endorsement.

## Frozen provenance

- Repository: `https://github.com/DiffCI/core`
- Base: [`db1d637dfcca8d8f7fa047500dfe0027d0d018a7`](https://github.com/DiffCI/core/commit/db1d637dfcca8d8f7fa047500dfe0027d0d018a7)
- Head: [`cdf3bf288715261666cdc074c4a335e8653d4f9a`](https://github.com/DiffCI/core/commit/cdf3bf288715261666cdc074c4a335e8653d4f9a)
- CLI: `@diffci.com/diffci@0.3.2`
- Observation schema: `diffci.observation.v1`
- Environment: Windows x64, Node.js 24.16.0, npm 11.13.0, Git 2.54.0.windows.1, 13th Gen Intel Core i5-1335U, 12 logical CPUs, 16,876,888,064 bytes memory

The head changes `src/git/git-diff.ts` and two Git-diff tests. Each raw report records the same explicit commit range, file list, graph evidence, and non-interference digest.

## Protocol

The target was a disposable clean clone checked out at the exact head. Dependencies were prepared once with `npm ci --ignore-scripts`; the ignored `node_modules` directory remained warm for all three attempts. OS and npm caches were not cleared. Each attempt ran the same pinned command and wrote its report outside the target checkout:

```sh
npm ci --ignore-scripts
npx --yes @diffci.com/diffci@0.3.2 check \
  --repo /path/to/clean/core-checkout \
  --base db1d637dfcca8d8f7fa047500dfe0027d0d018a7 \
  --head cdf3bf288715261666cdc074c4a335e8653d4f9a \
  --out /path/to/check-NN.json \
  --json --quiet
```

The repository's full command at this revision is `npm test`. There is no selected command: all three reports state `Repository declares no recognised test framework; DiffCI cannot construct a command that would run a subset of its tests`.

Alternating full/selected execution was therefore impossible and was not simulated. The three attempts remain in the denominator as command-synthesis refusals. A future paired runtime claim would require a real executable selected command, cache preparation before every arm, at least three alternating repetitions, and retention of every failure or refusal.

## Attempts and analysis overhead

| Attempt | Static selection | Command result | Total observer time | Graph time | Worktree unchanged |
| --- | ---: | --- | ---: | ---: | --- |
| 1 | 4 / 31 tests | Refused | 2.751 s | 1.643 s | Yes |
| 2 | 4 / 31 tests | Refused | 2.956 s | 1.872 s | Yes |
| 3 | 4 / 31 tests | Refused | 2.769 s | 1.663 s | Yes |

Median observer time was 2.769 seconds; median graph time was 1.663 seconds. These are analysis overhead measurements, not test runtime or savings. Denominator: 3 attempts; 3 command-synthesis refusals; 0 paired measurements; 0 discarded attempts.

## Raw artifacts and limitations

- [`check-01.json`](check-01.json)
- [`check-02.json`](check-02.json)
- [`check-03.json`](check-03.json)
- [`sha256sums.txt`](sha256sums.txt)

The evaluation covers one historical change in DiffCI's own repository on one Windows laptop. It does not establish behavior on independent repositories, hosted runners, other operating systems, cold dependency caches, or Core's entire CI surface. The static selection count is not a savings measurement. Required full CI remains authoritative.
