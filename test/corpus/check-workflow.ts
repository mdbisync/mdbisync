// Published with every slice, outside all annotated document folders.
export const CHECK_WORKFLOW_PATH = '.github/workflows/harness-check.yml';
export const CHECK_MARKER = '.harness-check';
export const CHECK_NAME = 'format';

/** A read-only marker check; a new head cancels the previous head's pending job. */
export const CHECK_WORKFLOW = `name: Harness check
on:
  push:
    branches: ['t/*/main']
  pull_request:
    branches: ['t/*/main']
    types: [opened, synchronize, reopened, closed]
permissions:
  contents: read
concurrency:
  group: harness-check-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  format:
    name: format
    if: github.event_name == 'push' || (github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: self-hosted
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
          persist-credentials: false
      - name: Read the requested state
        shell: bash
        env:
          CHECK_ATTEMPT: \${{ github.run_attempt }}
        run: |
          if [ -e .harness-check-fixed ]; then exit 0; fi
          if [ ! -e ${CHECK_MARKER} ]; then exit 0; fi
          case "$(cat ${CHECK_MARKER})" in
            flaky) if [ "$CHECK_ATTEMPT" -gt 1 ]; then exit 0; fi ;;
            document)
              if [ -f .harness-check-target ] && grep -qF 'Approved for review.' "$(cat .harness-check-target)"; then exit 0; fi
              ;;
            failed) ;;
            pending) sleep 1140; exit 1 ;;
            *) echo 'Invalid check marker'; exit 1 ;;
          esac
          # The fixture selects the annotated document; never quote document content.
          while IFS= read -r -d '' file; do
            property="\${file//'%'/'%25'}"
            property="\${property//$'\\r'/'%0D'}"
            property="\${property//$'\\n'/'%0A'}"
            property="\${property//':'/'%3A'}"
            property="\${property//','/'%2C'}"
            echo "::error file=$property,line=1,title=Review required::Check the review status."
          done < <(git --literal-pathspecs ls-files -z -- "$(cat .harness-check-target)")
          exit 1
`;
