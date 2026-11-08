# Format probe

Linear stores documents in its own Markdown form. The probe finds that form
by experiment instead of trusting documentation: for every synchronized
fixture of the bank (`test/fixtures/`) it

1. writes the fixture to a new Linear document in a short-lived project,
   with links to bank assets replaced by freshly uploaded files;
2. reads the document back, with its stored Yjs state (`contentState`);
3. writes that readback again and reads once more, to see whether Linear's
   form is a fixed point;
4. records Linear's form beside the fixture as `<name>.linear.md`, the
   decoded Yjs tree as `<name>.linear.yjs.json`, and each fixture's fixed
   point and refusal in `test/fixtures/linear-probe.json`.

Uploaded asset URLs are mapped back to their bank paths (percent-encoded,
like the URL they stand for), and ids and users in the Yjs tree are
replaced by placeholders, so the recorded forms do not change from run to
run. A fixture that spells an asset path differently (for example in angle
brackets) therefore shows a change that comes from the upload, not from
Linear.

It also measures what the engine depends on: the title and content length
limits and how the content limit counts, upload size refusals, whether
`documentCreate` and `documentUpdate` return the stored content, how trashed
documents appear in queries, whether a team filter returns project
documents, the complexity cost of the queries, and the rate-limit headers.
Linear's refusals are findings and appear in the report.

## Run

```sh
export LINEAR_TEST_APP_CLIENT_ID=... LINEAR_TEST_APP_CLIENT_SECRET=...
npm run probe:format -- --report report.md   # compare with the record; exit 1 on drift
npm run probe:format -- --update             # record this run's forms
```

| Option | Meaning |
| --- | --- |
| `--update` | write this run's forms as the new record instead of comparing |
| `--report <file>` | write a Markdown report: facts, one row per construct, Linear's changes |
| `--report-title <title>` | front-matter title for the report |
| `--json <file>` | the run's results as JSON, without fixture text, Linear forms or Yjs trees |
| `--only <text>` | probe only fixtures whose path contains the text |
| `--no-facts` | skip the limit and cost measurements (about 60 requests) |

The OAuth app needs client credentials with read and write scopes. The
probe mints a token for the run and revokes it at the end; it removes its
project at the end, also on failure, and removes probe projects older than
two hours left by killed runs: only projects with the probe's exact name
pattern that the app itself created. `LINEAR_TEST_TEAM_KEY` picks the team (default:
the first one); `LINEAR_BASE_URL` puts a proxy in front of Linear.

A full run sends about 650 API requests, one at a time. Exit codes: 0 no
drift, 1 drift, 2 the run could not finish or left its project behind.

If Linear stops serving `contentState` (an internal field), the probe
reports the Yjs part as blocked and still checks the Markdown forms.
