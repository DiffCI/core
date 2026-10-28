# License history

DiffCI Core was first published under AGPL-3.0-only. It is now licensed under
the MIT License.

All prior releases of DiffCI Core and the `@diffci.com/diffci` CLI are also
available under the MIT License, in addition to AGPL-3.0-only, except for the
contribution from #16 described below. Files inside already-published release
archives still contain the AGPL text; this statement grants the additional MIT
license for them.

Outside contributors to the AGPL-licensed versions were asked to agree to this
relicensing for all past and future versions in
[#43](https://github.com/DiffCI/core/issues/43):

| Contributor | Pull requests | Status |
| --- | --- | --- |
| @FredApps | #32, #33, #34, #35, #36 | [consented](https://github.com/DiffCI/core/issues/43#issuecomment-6414291007) |
| @varshith84 | #16 | not relicensed; removed and replaced |

The only contribution from #16, a Vue transitive-selection regression test in
`tests/repo/language-adapters.test.ts`, was removed before the MIT switch. It was
replaced with new tests written by the DiffCI maintainers from the acceptance
criteria in [#6](https://github.com/DiffCI/core/issues/6). Copies of the #16
test in earlier versions of this repository remain under AGPL-3.0-only.
