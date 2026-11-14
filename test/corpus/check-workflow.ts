// Published with every slice, outside all annotated document folders.
//
// A scenario sets the check's outcome with an empty commit whose trailers
// name the requested state, never with a file: the sync merges only
// synchronized documents by itself, so a file of the harness on a sync
// branch would hold its pull request for a person. The state of a head is
// the latest such commit in its history, by sequence. The sync's set-aside
// head, which keeps only the tracked branch's tree, keeps only the tracked
// branch's history here too, so a suspended batch's state leaves the normal
// lane with its documents.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SET_ASIDE_MESSAGE } from '../../src/sync/suspended.ts';

export const CHECK_WORKFLOW_PATH = '.github/workflows/harness-check.yml';
export const CHECK_NAME = 'format';

/** The trailers of a check state commit. */
export const CHECK_TRAILER = 'Harness-check';
export const CHECK_TARGET_TRAILER = 'Harness-check-target';
export const CHECK_SEQUENCE_TRAILER = 'Harness-check-sequence';

/**
 * What a check state commit asks for. `failed`, `flaky`, `document` and
 * `pending` set the state and drop an earlier `fixed`; `passed` clears the
 * state; `fixed` clears it and passes every head that holds it (a person's
 * fix on the tracked branch) until a later state; `reset` clears both.
 */
export type CheckEvent = 'failed' | 'flaky' | 'document' | 'pending' | 'passed' | 'fixed' | 'reset';

let lastSequence = 0;

/** The message of a check state commit; sequences only grow, so the latest request wins wherever histories merge. */
export function checkStateMessage(event: CheckEvent, target?: string): string {
  lastSequence = Math.max(Date.now(), lastSequence + 1);
  if (target !== undefined && /[\r\n]/.test(target)) throw new Error('a check target is one line');
  return [`Set check state to ${event}`, '', `${CHECK_TRAILER}: ${event}`, ...(target === undefined ? [] : [`${CHECK_TARGET_TRAILER}: ${target}`]), `${CHECK_SEQUENCE_TRAILER}: ${lastSequence}`, ''].join('\n');
}

/**
 * Prints the state of `$CHECK_REF` (HEAD when unset): `passed`, or the mode
 * and its target separated by a tab. Reads only history, so it runs in a
 * bare repository too. Written without `${`, so it can sit in the workflow
 * text below.
 */
export const CHECK_STATE_SCRIPT = `ref=$CHECK_REF
[ -n "$ref" ] || ref=HEAD
head=$(git rev-parse --verify --quiet "$ref^{commit}")
sep=$(printf '\\037')
git log --format="%H$sep%P$sep%s$sep%(trailers:key=${CHECK_TRAILER},valueonly,separator=%x20)$sep%(trailers:key=${CHECK_TARGET_TRAILER},valueonly,separator=%x20)$sep%(trailers:key=${CHECK_SEQUENCE_TRAILER},valueonly,separator=%x20)" "$head" |
  awk -F "$sep" -v head="$head" -v cut='${SET_ASIDE_MESSAGE}' '
    { parents[$1] = $2; subject[$1] = $3; kind[$1] = $4; target[$1] = $5; order[$1] = $6 }
    END {
      n = 1; stack[1] = head; m = 0
      while (n > 0) {
        c = stack[n]; n--
        if (c in seen) continue
        seen[c] = 1
        if (kind[c] != "" && order[c] != "") { m++; events[m] = c }
        k = split(parents[c], p, " ")
        for (i = (subject[c] == cut ? 2 : 1); i <= k; i++) { n++; stack[n] = p[i] }
      }
      for (i = 2; i <= m; i++) { e = events[i]; for (j = i - 1; j >= 1 && order[events[j]] + 0 > order[e] + 0; j--) events[j + 1] = events[j]; events[j + 1] = e }
      mode = ""; file = ""; fixed = 0
      for (i = 1; i <= m; i++) {
        e = events[i]
        if (kind[e] == "passed") { mode = ""; file = "" }
        else if (kind[e] == "fixed") { mode = ""; file = ""; fixed = 1 }
        else if (kind[e] == "reset") { mode = ""; file = ""; fixed = 0 }
        else { mode = kind[e]; file = target[e]; fixed = 0 }
      }
      if (fixed || mode == "") print "passed"; else print mode "\\t" file
    }'
`;

/** A head's requested state, read from its history in the repository at `dir`. */
export async function readCheckState(dir: string, sha: string): Promise<{ mode: string; target: string | undefined }> {
  const { stdout } = await promisify(execFile)('bash', ['-e', '-o', 'pipefail', '-c', CHECK_STATE_SCRIPT], { cwd: dir, env: { ...process.env, CHECK_REF: sha }, maxBuffer: 64 * 1024 * 1024 });
  const [mode = '', target] = stdout.replace(/\n$/, '').split('\t');
  return { mode, target: target === undefined || target === '' ? undefined : target };
}

const indent = (text: string, spaces: number) => text.trimEnd().split('\n').map((line) => `${' '.repeat(spaces)}${line}`).join('\n');

/** A read-only check of the requested state; a new head cancels the previous head's pending job. */
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
          fetch-depth: 0
          persist-credentials: false
      - name: Read the requested state
        shell: bash
        env:
          CHECK_ATTEMPT: \${{ github.run_attempt }}
        run: |
          state=$(
${indent(CHECK_STATE_SCRIPT, 12)}
          )
          mode=$(printf '%s\\n' "$state" | cut -f1)
          target=$(printf '%s\\n' "$state" | cut -s -f2)
          case "$mode" in
            passed) exit 0 ;;
            flaky) if [ "$CHECK_ATTEMPT" -gt 1 ]; then exit 0; fi ;;
            document)
              if [ -f "$target" ] && grep -qF 'Approved for review.' "$target"; then exit 0; fi
              ;;
            failed) ;;
            pending) sleep 1140; exit 1 ;;
            *) echo 'Invalid check state'; exit 1 ;;
          esac
          # The fixture selects the annotated document; never quote document content.
          while IFS= read -r -d '' file; do
            property="\${file//'%'/'%25'}"
            property="\${property//$'\\r'/'%0D'}"
            property="\${property//$'\\n'/'%0A'}"
            property="\${property//':'/'%3A'}"
            property="\${property//','/'%2C'}"
            echo "::error file=$property,line=1,title=Review required::Check the review status."
          done < <(git --literal-pathspecs ls-files -z -- "$target")
          exit 1
`;
