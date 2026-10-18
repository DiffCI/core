# Published CLI source archives

The corresponding source for the already-published
[`@diffci.com/diffci@0.3.10`](https://www.npmjs.com/package/@diffci.com/diffci/v/0.3.10)
is preserved at the immutable
[`cli-v0.3.10-source`](https://github.com/DiffCI/core/tree/cli-v0.3.10-source/packages/diffci-cli)
tag. The tag contains the original source closure, package metadata, lockfile,
license, tarball integrity details, and a digest manifest.

The historical lockfile is retained byte-for-byte and resolves its public Core
dependency through SSH. To build the archived client without a GitHub SSH
credential, intentionally bypass that historical lock:

```sh
npm install --package-lock=false --omit=dev --no-audit --fund=false
npm run build:client
```

This produces equivalent client output. The published tarball SHA-1 and
integrity recorded in the archive remain the byte-level artifact references;
line endings can differ on Windows.

New CLI releases are built from `packages/diffci-cli/` on Core's main branch and
are published only through the dedicated trusted-publishing workflow.
