# `@diffci.com/diffci` v0.3.10 corresponding source

This directory preserves the corresponding source for the already-published
`@diffci.com/diffci@0.3.10` npm tarball. It is intentionally kept in the
public Core repository before the historical product repository becomes
private, so users of the AGPL-licensed executable retain a public source
location.

- Original public source commit: `c2314eb9dfb965ca1e6a17ef1ccffe9f5843eea6`
- npm tarball SHA-1: `41dda3e616ff374888be2278981126836083b5a3`
- npm integrity: `sha512-uQcS9/ICMo4VCmvx7j829AdWMjJkUdcaiRegxRDc9orUrQBkhNqr2dmRlxlXd+hMRqX85KourasUfBUs5JeSNg==`
- Public engine dependency: `DiffCI/core@9d575cef7b1dd118300cd6298c9f85a8c1a44ad8`

The archived executable source is the `src/client/` tree plus the two
preflight helpers it imports. `tsconfig*.json`, the package manifest and lock,
and the executable-bit build script are included so this client can be built
from source. `SOURCE-MANIFEST.json` records a SHA-256 digest for every archived
file.

The historical `package.json` remains unmodified for reproducibility, including
its original repository metadata. Do not publish this source-archive revision.
The successor package released from this repository will have Core-based
metadata and a new version.

To reproduce the client build with Node.js 22.5 or later:

```sh
npm ci
npm run build:client
```

The archive contains only the CLI/MCP source closure already distributed in the
npm package, its public Core dependency, and build metadata. It excludes hosted
product services, deployment code, website code, private research, and
operational data.
