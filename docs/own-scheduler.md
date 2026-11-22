# Run the sync from your own scheduler

Every sync run works both ways. A push to `main` starts one at once, so
git reaches Linear within a minute or two, and that run also takes in
what changed in Linear. Between pushes, a Linear edit waits for the next
run started by hand or by your own timer through `workflow_dispatch`. Run
a timer that starts the workflow every few minutes.

## Why not GitHub's schedule

GitHub documents that a scheduled run can be delayed when Actions is under
high load, and that some queued jobs may then be dropped
([the `schedule` event](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)).
It names no plan that is exempt and publishes no delivery guarantee, so a
run asked for every five minutes can start hours late, or not at all, and
a Linear edit waits that long. GitHub also runs schedules only from the
default branch, no more often than every five minutes, and turns them off
in a public repository after 60 days without activity
([disabling a workflow](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow)).

So `mdbisync.yml` has no `schedule:` trigger. If your copy has one, from an
earlier release, remove it and keep `push` and `workflow_dispatch` under
`on:`; otherwise GitHub's late runs come on top of your timer's and, in a
private repository, use up minutes.

## How it works

Your scheduler sends one HTTPS request every few minutes:

```text
POST https://api.github.com/repos/<owner>/<repository>/actions/workflows/mdbisync.yml/dispatches
{"ref": "main"}
```

GitHub answers `204 No Content` and queues a run of `mdbisync.yml` on
`main` ([create a workflow dispatch event](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)).
Any scheduler that can send that request works: cron, a systemd timer, a
scheduled job in another CI system or a cloud scheduler. It needs outbound
HTTPS only; nothing has to reach it from the internet. A dispatch from a
scheduled workflow in another GitHub repository does not help: it is the
same GitHub schedule.

The workflow needs no change. Its `mdbisync` concurrency group runs one
run at a time and keeps at most one waiting run, the newest, so dispatches
that arrive during a run do not pile up. A run that finds nothing changed
in Linear is short and writes nothing.

## The token

The request needs a token that may start workflows in the repository. Use
a fine-grained personal access token made for this alone
([creating a fine-grained token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)),
not the sync's GitHub App key:

- **Resource owner:** the account or organization that owns the docs
  repository. An organization may have to approve the token first.
- **Expiration:** a date. Renew the token before it expires, or the
  timer's requests start to fail.
- **Repository access:** Only select repositories, and only the docs
  repository.
- **Repository permissions:** Actions, Read and write. Nothing else
  (GitHub adds Metadata, Read-only, by itself).

With only the Actions permission the token cannot read the repository's
files through the contents API, push, read secrets or change the sync's
state directly. In that repository it can still:

- start, with any inputs, re-run (also with debug logging) and cancel runs
  of any workflow, the initial sync workflow included;
- enable and disable workflows;
- read and delete run logs and artifacts, and delete caches.

So whoever holds the token can start a confirmed initial sync: from git to
Linear it overwrites the synchronized Linear documents and moves those
without a file to Linear's trash, and from Linear to git it opens a pull
request that can remove files. They can also read logs and artifacts, which
can hold paths, document titles or file content. Guard the token like write
access to your synchronized Linear documents. Keep it only on the
scheduler's host, in a file only its user can read (mode 600) or in that
system's secret store, never in the repository or its Actions secrets.

An organization can dispatch with an installation token of a GitHub App
that has only the Actions write permission instead: the same request, the
same permission. That puts the App's private key on the scheduler's host,
so this page gives no recipe for it.

## Choose the interval

Each dispatch is one run. Runs of a public repository on GitHub's standard
hosted runners cost nothing. In a private repository each run on a
GitHub-hosted runner is billed against your plan's included minutes (2,000 a
month on GitHub Free), rounded up to a whole minute per job. The table
counts the timer's runs; runs that pushes start come on top:

| Interval | Runs a day | Minutes a month (30 days), at least |
| --- | --- | --- |
| 5 minutes | 288 | 8,640 |
| 10 minutes | 144 | 4,320 |
| 15 minutes | 96 | 2,880 |
| 30 minutes | 48 | 1,440 |

- **Within the free minutes.** On GitHub Free, a 30-minute interval fits in
  the 2,000 minutes and leaves room for the runs pushes start.
- **Every five minutes,** for a sync that feels immediate: about 8,640
  minutes a month. Pay GitHub for the extra minutes, or run the workflow on
  a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners)
  by setting its `runs-on` to the runner's labels; that costs only your
  server. Prices and the terms for self-hosted runners are in
  [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

An interval shorter than a run only keeps one run waiting behind it.

## A dispatch script

Both examples below run this script. Save it as
`~/.local/bin/mdbisync-dispatch`, replace `<owner>/<repository>`, and make
it executable (`chmod 700 ~/.local/bin/mdbisync-dispatch`):

```sh
#!/bin/sh
# Starts the mdbisync workflow on main once.
set -eu
repository='<owner>/<repository>'
# systemd's LoadCredential= puts the token in $CREDENTIALS_DIRECTORY;
# otherwise the script reads the file directly.
token_file="${CREDENTIALS_DIRECTORY:-$HOME/.config/mdbisync}/dispatch-token"
# Drops a trailing newline, carriage return or spaces from the file.
token=$(tr -d '[:space:]' < "$token_file")
# The token goes to curl on stdin, so it is never on a command line.
status=$(printf 'Authorization: Bearer %s\n' "$token" |
  curl --silent --show-error --max-time 30 \
    --output /dev/null --write-out '%{http_code}' \
    --request POST --header @- \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    --data '{"ref":"main"}' \
    "https://api.github.com/repos/$repository/actions/workflows/mdbisync.yml/dispatches" ||
  true)
case $status in
  2??) ;;
  *) echo "mdbisync dispatch failed: HTTP $status" >&2; exit 1 ;;
esac
```

Put the token in `~/.config/mdbisync/dispatch-token`:

```sh
mkdir -p ~/.config/mdbisync && chmod 700 ~/.config/mdbisync
(umask 077 && cat > ~/.config/mdbisync/dispatch-token)
# paste the token, press Enter, then Ctrl-D
```

Run the script once by hand. It prints nothing and a new **mdbisync** run
appears in the Actions tab within a minute. A failure names the HTTP
status: `401` for a wrong or expired token, `403` for a token without the
Actions write permission, `404` for a wrong repository or workflow name or
a token without access to the repository, `000` for a network failure or
timeout. Another `4xx` status usually means the workflow is disabled or
the branch does not exist: check Actions → **mdbisync**.

## Example: cron

`crontab -e`, then add:

```text
*/5 * * * * "$HOME/.local/bin/mdbisync-dispatch"
```

The script is silent when the request succeeds, so cron sends mail (where
the host delivers it) only for a failure.

## Example: a systemd user timer

`~/.config/systemd/user/mdbisync-dispatch.service`:

```ini
[Unit]
Description=Start the mdbisync workflow

[Service]
Type=oneshot
TimeoutStartSec=60
LoadCredential=dispatch-token:%h/.config/mdbisync/dispatch-token
ExecStart=%h/.local/bin/mdbisync-dispatch
```

`~/.config/systemd/user/mdbisync-dispatch.timer`:

```ini
[Unit]
Description=Start the mdbisync workflow every five minutes

[Timer]
OnCalendar=*:0/5
RandomizedDelaySec=30
Persistent=true

[Install]
WantedBy=timers.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now mdbisync-dispatch.timer
loginctl enable-linger "$USER"   # keeps the timer running without a login session
systemctl --user list-timers mdbisync-dispatch.timer
journalctl --user -u mdbisync-dispatch
```

A failed request leaves the service failed with the script's message in
the journal. If the service fails with `status=243/CREDENTIALS` before
the script runs, your systemd does not support `LoadCredential=` in user
services: remove that line, and the script reads the token file itself.
For a different interval, change `OnCalendar=` (`*:0/10` is every ten
minutes), then run `systemctl --user daemon-reload` and
`systemctl --user restart mdbisync-dispatch.timer`.

## Example: another scheduler

In another CI system's scheduled pipeline or a cloud scheduler, run the
same request: keep the token in that system's secret store, make sure its
logs never print it, and let a failed request fail the job.

## Stop the timer during an initial sync

Start the timer only after the first initial sync has finished and the
sync workflow is in place: before that its dispatches would only fail.
Before a later initial sync (recovery), disable the sync workflow and stop
the timer: both workflows share one queue, so a dispatched sync could
replace an initial sync that waits behind a running sync. Enable and start
them again when the initial sync is in place:

- systemd: `systemctl --user stop mdbisync-dispatch.timer`, later
  `systemctl --user start mdbisync-dispatch.timer`;
- cron: comment the line out, later remove the `#`.

## When runs keep failing

With a timer, a run that fails for a lasting reason (an expired Linear
secret, a failing setup check) fails at every interval, and GitHub notifies the token's owner about each failed run.
Fix the cause from the run summary
([troubleshooting](troubleshooting.md)), or stop the timer until you can.
