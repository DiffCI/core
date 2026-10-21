/** GitHub-hosted runner and Node 24 action pins shared by every workflow the CLI generates. */
export const RUNNER = "ubuntu-26.04";
export const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"; // actions/checkout v7.0.1
export const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020"; // actions/setup-node v7.0.0
export const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"; // actions/upload-artifact v7.0.1

export function diffciWorkflow(version: string): string {
  return `name: DiffCI observation
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci:
    runs-on: ${RUNNER}
    continue-on-error: true
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # immutable checkout pin
        with:
          fetch-depth: 0
      - uses: actions/setup-node@${SETUP_NODE_SHA} # immutable setup-node pin
        with:
          node-version: 22
      - run: npx "@diffci.com/diffci@${version}" observe --no-send
`;
}

export function diffciVerificationWorkflow(version: string): string {
  return `name: DiffCI verification
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci-verify:
    name: DiffCI verification
    runs-on: ${RUNNER}
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # immutable checkout pin
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@${SETUP_NODE_SHA} # immutable setup-node pin
        with:
          node-version: 22
      - name: Verify changed code
        run: npx "@diffci.com/diffci@${version}" verify --json --out "$RUNNER_TEMP/diffci-verification.json"
      - name: Upload verification receipt
        if: always()
        uses: actions/upload-artifact@${UPLOAD_ARTIFACT_SHA} # immutable upload-artifact v7 pin
        with:
          name: diffci-verification-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/diffci-verification.json
          if-no-files-found: warn
`;
}
