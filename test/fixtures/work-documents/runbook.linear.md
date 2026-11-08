# Runbook: restart the queue worker

> [!WARNING]
> Restarting drops jobs that are in flight. Drain the queue first.

## Steps

1. Pause new jobs:

   ```sh
   worker pause
   ```
2. Wait until the queue is empty.
3. Restart the service:

   ```sh
   systemctl restart worker
   ```
4. Resume jobs and watch the dashboard for five minutes.

## Rollback

If the worker does not start, restore the previous release and page the on-call engineer.

Ref kx-ce481f48