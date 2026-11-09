// Published with every slice, outside all annotated document folders.
export const CHECK_WORKFLOW_PATH = '.github/workflows/harness-check.yml';
export const CHECK_MARKER = '.harness-check';
export const CHECK_NAME = 'format';

/** A read-only PR check; a new head cancels the previous head's pending job. */
export const CHECK_WORKFLOW = `name: Harness check
on:
  pull_request:
    branches: ['t/*/main']
permissions:
  contents: read
concurrency:
  group: harness-check-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  format:
    name: format
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: self-hosted
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - name: Read the requested state
        shell: bash
        run: |
          if [ ! -e ${CHECK_MARKER} ]; then exit 0; fi
          case "$(cat ${CHECK_MARKER})" in
            failed) exit 1 ;;
            pending) sleep 1140; exit 1 ;;
            *) echo 'Invalid check marker'; exit 1 ;;
          esac
`;
