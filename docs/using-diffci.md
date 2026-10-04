# Use DiffCI in your repository

The published [`@diffci.com/diffci` CLI](https://www.npmjs.com/package/@diffci.com/diffci) bundles this Core engine. Run it from the root of an existing Git checkout with Git and Node.js 22.5 or later installed. Both the head commit and its first parent must be available locally.

## Check selection and runtime

```sh
npx @diffci.com/diffci@latest check
```

On Windows PowerShell, quote the package name:

```powershell
npx '@diffci.com/diffci@latest' check
```

`check` analyzes the checkout, infers the repository's full test command, and runs the full and proposed selected commands when safe to compare. It reports measured paired runtime only when both commands pass. Test commands may write generated files into your checkout. DiffCI writes its reports outside the repository and sends nothing by default. Keep existing required CI checks in place.

## Analyze without running tests

```sh
npx @diffci.com/diffci@latest observe --no-send
```

`observe --no-send` reports selected tests, fallback reasons, and command availability without executing the repository's tests or sending a report. It does not establish runtime savings.

## Recover a missing base in a shallow checkout

DiffCI must be able to read both revisions, and the checkout must still be at the requested head. In CI, set `BASE` and `HEAD` to the full commit IDs supplied by the pull-request or merge-request event, then verify them before asking DiffCI for a plan:

```sh
BASE=0123456789abcdef0123456789abcdef01234567
HEAD=89abcdef0123456789abcdef0123456789abcdef

git rev-parse --is-shallow-repository
git rev-parse --verify HEAD

if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  git fetch --no-tags --deepen=100 origin
fi

if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "DiffCI base is still unavailable; run the repository's full CI." >&2
  exit 1
fi

if [ "$(git rev-parse HEAD)" != "$HEAD" ]; then
  echo "The requested head is not checked out; run the repository's full CI." >&2
  exit 1
fi
```

Increase the deepen count or use `git fetch --no-tags --unshallow origin` when the base is farther back. Do not interpret a missing base, a fetch failure, or a head mismatch as an empty or safe selection.

For a built checkout of this Core repository, request the advisory plan with both verified revisions:

```sh
node /path/to/core/dist/cli.js plan \
  --repo "$PWD" \
  --base "$BASE" \
  --head "$HEAD"
```

For the published CLI, pass the same revisions to `check`:

```sh
npx --yes @diffci.com/diffci@latest check \
  --base "$BASE" \
  --head "$HEAD"
```

`plan` is advisory; `check` may execute repository test commands. If either command refuses or errors, run the repository's normal full validation.

## Reproduce a full fallback

This synthetic project has one unsupported dependency shape: `loader.js` chooses an import at runtime, so static analysis cannot enumerate every module the changed loader may reach. The tree is:

```text
package.json
tsconfig.json
src/loader.js
src/value.js
test/loader.test.js
```

Create its base revision in a disposable directory:

```sh
git init -b main diffci-fallback-example
cd diffci-fallback-example
git config user.name "DiffCI Docs"
git config user.email "docs@diffci.com"
mkdir -p src test
cat > package.json <<'JSON'
{
  "name": "diffci-fallback-example",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true
  },
  "include": ["src/**/*.js", "test/**/*.js"]
}
JSON
cat > src/loader.js <<'JS'
export async function load(name) {
  return import(`./${name}.js`);
}
JS
printf 'export const value = 1;\n' > src/value.js
cat > test/loader.test.js <<'JS'
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "../src/loader.js";

test("loads a named module", async () => {
  assert.equal((await load("value")).value, 1);
});
JS
git add .
GIT_AUTHOR_DATE=2026-10-04T00:00:00Z GIT_COMMITTER_DATE=2026-10-04T00:00:00Z git commit -m "base fixture"
```

Then make and commit the analyzed change:

```sh
cat > src/loader.js <<'JS'
export async function load(name) {
  const normalized = name.trim();
  return import(`./${normalized}.js`);
}
JS
git add src/loader.js
GIT_AUTHOR_DATE=2026-10-04T00:01:00Z GIT_COMMITTER_DATE=2026-10-04T00:01:00Z git commit -m "normalize module names"
npx --yes @diffci.com/diffci@0.3.2 observe --no-send \
  --base c82c935ca9761a76cc9849d1e3ce3c08cfa99509 \
  --head e1de15d114174f99098beba785e389268ff7e8dc \
  --json
```

The pinned reproduction reports `mode: "FULL"`, `analysisStatus: "FALLBACK"`, no proposed commands, and:

```text
Dependency graph confidence is UNSAFE; full validation required
```

Run `npm test` for this revision. Even though the report lists one selected test out of one discovered test, that count is not a runtime measurement or a savings claim. The computed import could reach modules static analysis did not discover, so only the repository's normal full validation remains authoritative. CLI behavior may evolve after version 0.3.2; keep the pinned version when reproducing this exact output.

## Interpret the result

- A full-validation fallback means DiffCI could not justify a smaller selection for that change. Run the repository's normal tests.
- A selected command is evidence about the analyzed revision. It does not authorize skipping required CI tests.
- `REFUSED` and `ERROR` mean analysis did not succeed. Use the normal test commands and inspect the reported reason.
- One paired timing is preliminary. Repeat measurements and account for cache and setup costs before claiming savings.

For supported languages and setup limits, see the [support matrix](https://github.com/DiffCI/DiffCI.com/blob/main/docs/language-support.md). For the difference between this engine and the published CLI, see the [package relationship](https://github.com/DiffCI/DiffCI.com/blob/main/docs/package-relationship.md).
