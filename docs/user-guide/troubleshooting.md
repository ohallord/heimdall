# Troubleshooting

Find your symptom below. Each entry gives the likely cause and the fix. Specific incidents have their own runbooks in [`../runbooks/`](../runbooks/).

**Where to look first**

| Component | Logs |
| --- | --- |
| Agent (systemd) | `journalctl -u heimdall-agent -f` |
| OTel collector (systemd) | `journalctl -u heimdall-otelcol -f` |
| Hub (Compose) | `docker compose logs -f hub` |
| Hub / agent (Helm) | `kubectl -n heimdall logs deploy/heimdall-hub` · `deploy/heimdall-agent` |
| Hub health | `curl -s https://<hub>/api/v1/health` |

---

## Agents

### A new server never shows up
1. Check the agent log for errors: `journalctl -u heimdall-agent -n 50`.
2. Check that the host can reach the hub: `curl -s https://<hub>/api/v1/health`.
3. Check whether the enrollment token expired or ran out of uses (**Settings → Agents**, "Used" column). If so, create a new one and re-run the installer.

### `register failed … 401` or `403`
The token is wrong, expired, revoked, or used up. Or the bootstrap token is disabled and you used it. Create a fresh token with **+ Add a server**.

### `register failed … 409 hostname_in_use`
The hub already has an agent with this hostname, and this agent cannot prove it is that agent. This usually means `/var/lib/heimdall` was wiped or is not persistent.
**Fix:** host page → **Re-enroll**, then `systemctl restart heimdall-agent`. Make the state directory persistent (Helm PVC `agent.state.persistence`, a Compose volume, or the default path on bare metal).

### `403 agent_revoked`
An admin revoked this agent. Use **Re-enroll** and restart, if you meant to keep it.

### `persist agent secret … permission denied`
The agent user cannot write its state directory. On systemd, run `chown heimdall /var/lib/heimdall`. In Kubernetes, the chart sets `fsGroup`, so check your PVC storage class.

### Host shows offline (grey) but the agent is running
A host is online when a sample arrived within about 45 seconds. Look in the agent log for `metrics ingest failed`. Common causes are a hub restart (the agent recovers by itself), `429 rate_limited` (many agents sharing one token; raise `HEIMDALL_RATE_INGEST`), and clock or network problems.

### Agent shows a `legacy token` badge
It still authenticates with a shared token instead of its own secret. Restart or upgrade the agent so it registers and stores a secret. Once no badge remains, set `HEIMDALL_LEGACY_TOKENS=off` on the hub.

### No containers listed for a Docker host
- Look for `container collect warning` in the agent log.
- The agent user needs access to `/var/run/docker.sock` (be in the `docker` group). The installer does this unless `DOCKER=0` was set.
- In Compose, the sample agent runs as root with the socket mounted. If you set `HEIMDALL_AGENT_USER`, also set `DOCKER_GID`.

### "Mount missing" alarms for a path that does not exist on purpose
Remove it from `HEIMDALL_WATCH_MOUNTS`. The default `/,/boot,/var` assumes those are separate mounts. Containers often lack `/boot`.

### Disk usage in Kubernetes shows the container overlay, not the host
Enable host mounts: `agent.hostMounts.enabled=true` (the default). The agent then watches `/host` and `/host/var`.

### Kubernetes section is empty
- The agent needs `HEIMDALL_ENABLE_K8S=true` (the Helm agent has it on).
- The agent's ServiceAccount needs the chart's ClusterRole. If you see `k8s enabled but config unavailable`, the agent has no in-cluster config or `KUBECONFIG`.
- The cluster must be **active** under **Admin → Clusters**, and its ID must match `agent.clusterId`.

### Host posture says `trivy not found on PATH`
Install Trivy or set `HEIMDALL_TRIVY_BIN`. The default agent container image does not include Trivy. See [host-posture.md](../host-posture.md#troubleshooting).

---

## Signing in

### Login keeps returning to the login page (no error)
The session cookie is being dropped. If you browse over plain `http://`, set `HEIMDALL_COOKIE_SECURE=false` or make `HEIMDALL_PUBLIC_URL` an `http://` URL. Behind TLS, make sure `HEIMDALL_PUBLIC_URL` is `https://`.

### `403 csrf` when saving anything
The browser's origin does not match `HEIMDALL_PUBLIC_URL`. Set it to the exact URL users open, including scheme and port.

### `429 rate_limited` on login or MFA
Too many failed attempts. Wait for the `Retry-After` time. Behind a reverse proxy, everyone shares one IP bucket unless `HEIMDALL_TRUST_PROXY` is set. Limits are adjustable with `HEIMDALL_RATE_LOGIN` and `HEIMDALL_RATE_MFA`.

### Lost my authenticator
Sign in with a **recovery code** at the MFA prompt.

### MFA or SSO stopped working after a restart or restore
The hub log says `secret decrypt failed`. `HEIMDALL_SECRET_KEY` changed. Restore the original key and restart. If the key is gone, sign in with a recovery code and re-enter the SSO, alert and Git secrets.

### Passkey prompt fails
`HEIMDALL_RP_ID` must be the hostname you browse to, and `HEIMDALL_ORIGIN` the full origin. Passkeys enrolled under a different hostname have to be enrolled again.

### SSO: redirect URI mismatch
Register exactly `<HEIMDALL_PUBLIC_URL>/api/v1/auth/oidc/callback` with the IdP.

---

## Hub startup

| Message | Fix |
| --- | --- |
| `HEIMDALL_SESSION_SECRET must be set to at least 32 characters in production` | Set a 32+ character secret |
| `HEIMDALL_SECRET_KEY is required` | Set it (`openssl rand -hex 32`). Helm creates one unless you render with `helm template` |
| `set HEIMDALL_BOOTSTRAP_TOKEN in .env` (Compose) | Add it to `deploy/docker/.env` |
| Helm: `Set hub.env.HEIMDALL_BOOTSTRAP_TOKEN …` | Pass a token or `hub.existingSecret.name` on fresh installs |
| Helm: `nil pointer evaluating interface {}` | Use `--reset-then-reuse-values` ([runbook](../runbooks/helm-upgrade-new-values.md)) |
| `SECURITY: the bootstrap token is the well-known dev default…` | Rotate or disable it in **Settings → Agents** |
| `ECONNREFUSED …:5432` | Postgres is down. See the [Postgres recovery runbook](../runbooks/postgres-recovery.md) |
| `/install.sh` or `/downloads/*` returns 404 with a hint | Agent binaries are not built into this hub. Run `scripts/build-dist.sh` (the Docker image does this automatically) |

---

## Alerts

### No notifications arrive
Work through this list:

1. Is the hub **paused**? Look for the banner on **Alarms**, or `HEIMDALL_ALERTS_PAUSED`.
2. Is it inside **quiet hours** for every user who has them on? Only critical alerts go out during quiet hours.
3. Did every user turn the channel off in **Notification preferences**?
4. Is the alarm **muted**, or is it only in the **warn** (yellow) band? Warn-band alerts never notify.
5. **Cooldown:** the same rule, host and metric notifies at most once every 15 minutes.
6. Call `POST /api/v1/alerts/test` and read each channel's result. A `blocked_host` result means the webhook resolves to a private address; allow it with `HEIMDALL_ALLOW_PRIVATE_HOSTS`.

### Saving a webhook, IdP or GitLab URL fails with `blocked_host`
The URL resolves to a private, loopback or link-local address. Allow the narrowest entry in `HEIMDALL_ALLOW_PRIVATE_HOSTS`.

### Too many sudo alerts
Successful sudo commands are audit-only and do not alert. Alerts come only from failures or "not in sudoers" denials. If routine automation fails sudo regularly, fix that automation.

---

## OpenTelemetry

| Symptom | Fix |
| --- | --- |
| Collector logs `415` | Set `encoding: json` on the `otlphttp` exporter. The hub accepts OTLP/HTTP **JSON** only |
| Collector logs `401` | Wrong or rotated `hdo_` token. Update `/etc/heimdall/otel.env` and restart |
| `413` | Batches are too large. Keep at most 500 points or log records, or 1,000 spans, per request |
| Logs appear but not linked to the host | Set `heimdall.agent_id` (resource attribute) or `AGENT_ID` when installing |
| Service shows as `unknown_service` | Set `OTEL_SERVICE_NAME` in the app |

More in [otel.md](../otel.md).
