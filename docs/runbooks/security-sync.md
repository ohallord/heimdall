# Runbook: Security sync warnings (GitHub / GitLab remotes)

**Dashboard → Security → Sync GitHub / GitLab remotes** lists each warning under the button. The hub
also logs them:

```bash
kubectl -n heimdall logs deploy/heimdall-hub --since=1h | grep '\[security-sync\]'
```

| Warning | Cause | Fix |
| --- | --- | --- |
| `<kind>:<name> missing token` | Remote saved without a PAT | Dashboard → Remotes: add the token |
| `github dependabot 403 … User-Agent header` | Hub older than `fix/github-user-agent` | Deploy current `main` |
| `github dependabot <owner>/<repo> 403/401` | Personal account: the PAT can't read that repo's Dependabot alerts | Fine-grained PAT with **Dependabot alerts: read** on the repos (or classic `repo` / `security_events`) |
| `github code scanning <owner>/<repo> 403/401` | The PAT can't read that repo's code scanning alerts | Same `security_events` scope. A 404 ("no analysis") is skipped |
| `github advisories <org>: 403/404` | PAT lacks org security-advisory read | Optional; Dependabot findings still count |
| `gitlab project or namespace not found: <path>` | No project, user or group at that path, or token lacks `read_api` | Fix the path or token scope |
| `gitlab <group>/<project>: …` | One project in a user/group namespace failed (often no Ultimate security features) | Per project; others still sync |

URL-form names (`https://github.com/acme`, `https://gitlab.com/grp/app.git`) are accepted and stripped
to `acme` / `grp/app`.

Personal accounts: a GitHub name that isn't an org (the `/orgs/` endpoints 404) syncs each
non-archived repo it owns (first 100), skipping repos with Dependabot or code scanning off. A GitLab path that is a
user or group syncs each project in it (first 100). Findings are keyed `<repo>/<manifest>`.

0 findings with 0 warnings is a real result: no open alerts on the connected remotes.

## Schedule

The hub also runs the remote sync on a per-org crontab schedule. **Default: `0 8 * * *`** (daily at
08:00), enabled. Edit it on **Dashboard → Admin → Scheduled security sync**: cron expression
(5 fields: minute hour day month weekday), enable toggle, the next three runs, and the last run's
time, status (`ok` / `warnings` / `error`), findings written and warnings.

- **Time zone:** `HEIMDALL_TZ`, else `TZ`, else the server zone (UTC in the hub image). The admin
  screen shows which applies. Helm: `--set-string hub.extraEnv.HEIMDALL_TZ=Europe/Dublin`.
- **How it runs:** the hub polls every minute. Each org's `next_run_at` lives in
  `security_sync_schedules`; a run claims it with a conditional UPDATE, so a tick runs once even
  across restarts. A tick missed while the hub was down runs once at startup.
- **Turn it off:** untick Enabled per org, or `HEIMDALL_DISABLE_SECURITY_SYNC_JOB=1` for the hub.

Check scheduled runs:

```bash
kubectl -n heimdall logs deploy/heimdall-hub --since=24h | grep '\[security-sync\]'
```

Expect `scheduler started tz=…` at boot and one line per run:
`[security-sync] org=<id> scheduled run (0 8 * * *) status=ok written=N warnings=0 duration=…ms`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| No `scheduler started` line | `HEIMDALL_DISABLE_SECURITY_SYNC_JOB=1`, or hub older than the schedule feature | Unset it / deploy current `main` |
| Runs at the wrong hour | Hub time zone is UTC | Set `HEIMDALL_TZ`; next run is recomputed on the next poll |
| `status=error` | Sync threw (DB or code error); message stored on the admin screen | Read the log line, fix, wait for the next tick or click the manual sync |
| Last run stuck at `running` | Hub restarted mid-run | Harmless; the next tick overwrites it |

Closed alerts: after a sync, open `github` / `gitlab` findings the remotes no longer return are marked
resolved. A kind is skipped if any of its connections warned, failed, or lacks a token, so a partial
sync never hides real alerts. If closed alerts stay listed, clear that kind's warnings and sync again.

## Deploying the fix on homelab

`scripts/deploy-cluster.sh` imports images with `sudo k3s ctr`. Over non-interactive ssh it fails with
`k3s is installed but 'sudo k3s ctr version' failed`. Run it with a TTY:

```bash
ssh -t media 'cd /path/to/heimdall && sudo -v && ./scripts/deploy-cluster.sh 2>&1 | tee tmp/runner/deploy.log'
```
