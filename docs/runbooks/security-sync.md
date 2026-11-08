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
| `github advisories <org>: 403/404` | PAT lacks org security-advisory read | Optional; Dependabot findings still count |
| `gitlab project or namespace not found: <path>` | No project, user or group at that path, or token lacks `read_api` | Fix the path or token scope |
| `gitlab <group>/<project>: …` | One project in a user/group namespace failed (often no Ultimate security features) | Per project; others still sync |

URL-form names (`https://github.com/acme`, `https://gitlab.com/grp/app.git`) are accepted and stripped
to `acme` / `grp/app`.

Personal accounts: a GitHub name that isn't an org (the `/orgs/` endpoints 404) syncs each
non-archived repo it owns (first 100), skipping repos with Dependabot off. A GitLab path that is a
user or group syncs each project in it (first 100). Findings are keyed `<repo>/<manifest>`.

0 findings with 0 warnings is a real result: no open alerts on the connected remotes.

## Deploying the fix on homelab

`scripts/deploy-cluster.sh` imports images with `sudo k3s ctr`. Over non-interactive ssh it fails with
`k3s is installed but 'sudo k3s ctr version' failed`. Run it with a TTY:

```bash
ssh -t media 'cd /path/to/heimdall && sudo -v && ./scripts/deploy-cluster.sh 2>&1 | tee tmp/runner/deploy.log'
```
