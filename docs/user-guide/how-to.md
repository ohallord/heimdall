# How-to guides

Short recipes for common tasks. Each one says which role it needs.

- Servers and agents: [Add a server](#add-a-server) · [Remove or revoke a server](#remove-or-revoke-a-server) · [Re-enroll a server](#re-enroll-a-server) · [Monitor containers](#monitor-docker-or-podman-containers) · [Choose which disks are watched](#choose-which-disks-are-watched) · [Tail log files](#tail-log-files-with-the-agent) · [Monitor a Kubernetes cluster](#monitor-a-kubernetes-cluster) · [Run several clusters](#run-several-clusters)
- Alerts: [Configure alert channels](#configure-alert-channels) · [Send a test alert](#send-a-test-alert) · [Tune thresholds](#tune-cpu-memory-and-disk-thresholds) · [Turn off a rule](#turn-off-a-built-in-rule) · [Mute or dismiss](#mute-or-dismiss-an-alarm) · [Quiet hours](#set-quiet-hours) · [Pause all notifications](#pause-all-notifications)
- Security: [Scan host posture](#scan-a-hosts-packages-and-configuration) · [Scan a container image](#scan-a-container-image) · [Import OSV-Scanner results](#import-osv-scanner-results) · [Connect GitHub and GitLab](#connect-github-and-gitlab) · [Receive Falco events](#receive-falco-runtime-events) · [Critical findings → alarms](#turn-critical-findings-into-alarms)
- Observability: [Ship logs and metrics with OTel](#ship-journald-logs-and-host-metrics-with-opentelemetry) · [Send traces](#send-application-traces) · [Receive UniFi alarms](#receive-unifi-alarms)
- Accounts and access: [Enroll MFA](#enroll-mfa) · [Add SSO (OIDC)](#add-single-sign-on-oidc) · [Manage enrollment tokens](#manage-enrollment-tokens) · [Lock down the bootstrap token](#lock-down-the-bootstrap-token)
- Data: [Back up and restore](#back-up-and-restore) · [Change retention](#change-data-retention) · [Reach LAN services from the hub](#let-the-hub-reach-services-on-your-lan)

---

## Servers and agents

### Add a server
*Operator or admin.* **Settings → Agents → + Add a server**, copy the command, then run it on the host:

```bash
curl -fsSL https://<hub>/install.sh | sudo bash
```

Details and variants are in [Installation](installation.md#add-servers). To add many servers with one token, raise **max uses** when you create it.

### Remove or revoke a server
*Operator or admin.* Open the host from **Fleet**, then choose one of:

- **Revoke**: the agent's secret stops working immediately (`403 agent_revoked`). Use this for a compromised or decommissioned host.
- **Delete**: removes the host row and its data from the console.

Then uninstall on the host: `curl -fsSL https://<hub>/install.sh | sudo bash -s -- --uninstall` (add `PURGE=1` to remove `/var/lib/heimdall`).

### Re-enroll a server
Use this when an agent logs `409 hostname_in_use` (it lost its state directory) or `403 agent_revoked`.

1. Host page → **Re-enroll** (operator or admin).
2. Restart the agent: `sudo systemctl restart heimdall-agent`. It registers again with its enrollment token and gets a new secret.

### Monitor Docker or Podman containers
The agent finds a container runtime automatically by looking for these sockets, in order: `DOCKER_HOST_SOCKET` (default `/var/run/docker.sock`), `PODMAN_SOCKET` (default `/run/podman/podman.sock`), then the rootless Podman socket under `$XDG_RUNTIME_DIR`. The agent user needs read access to the socket. The installer adds it to the `docker` group. Be aware that Docker socket access is equivalent to root on that host.

### Choose which disks are watched
Set `HEIMDALL_WATCH_MOUNTS` in `/etc/heimdall/agent.env` (default `/,/boot,/var`), then restart the agent:

```bash
HEIMDALL_WATCH_MOUNTS=/,/var,/srv/data
```

A watched path that is not mounted raises a **Mount missing** alarm, so list only mounts that should always exist. In Helm, set the YAML list `agent.hostMounts.watchMounts` (never a comma-joined `--set` string, because Helm splits it).

### Tail log files with the agent
Add comma-separated paths to `/etc/heimdall/agent.env` and restart:

```bash
HEIMDALL_LOG_PATHS=/var/log/auth.log,/var/log/nginx/access.log
```

Lines appear under **Logs** and run through the threat rules. For systemd journal logs, use the OTel collector instead (see [below](#ship-journald-logs-and-host-metrics-with-opentelemetry)).

### Monitor a Kubernetes cluster
Install the Helm chart (see [Installation](installation.md#option-b-kubernetes-helm)). The in-cluster agent runs with `enableK8s: "true"` and RBAC to list nodes, pods, deployments, services, namespaces and NetworkPolicies. A standalone agent can do the same with `HEIMDALL_ENABLE_K8S=true` and a `KUBECONFIG`.

### Run several clusters
*Admin.*

1. Deploy one in-cluster agent per cluster, each with its own `agent.clusterId` (for example `prod-a`, `lab`).
2. **Admin → Clusters**: register each cluster ID.
3. Click **Activate** on the cluster the Fleet Kubernetes summary should show. Data from all clusters is kept.

---

## Alerts

### Configure alert channels
*Admin.* Channels are set in the setup wizard's **Alerts** step. There is no channel editor in Settings yet. To change channels later, send the same request the wizard sends. It updates channels in place:

```bash
curl -X POST https://<hub>/api/v1/setup/channels \
  -H 'Content-Type: application/json' -H 'Origin: https://<hub>' \
  -b 'heimdall_session=<your session cookie>' \
  -d '{
    "slackWebhookUrl": "https://hooks.slack.com/services/…",
    "discordWebhookUrl": "",
    "smtp": {"host":"smtp.example.com","port":587,"user":"…","pass":"…",
             "from":"heimdall@example.com","to":"ops@example.com"},
    "sms":  {"accountSid":"AC…","authToken":"…","from":"+15550001111","to":"+15552223333"}
  }'
```

The `Origin` header must match `HEIMDALL_PUBLIC_URL`, or the CSRF check rejects the request. The SMS channel works with Twilio and any API that is compatible with Twilio's Messages API (set `sms.apiBaseUrl`). If a webhook URL points at a private address, allow it with [`HEIMDALL_ALLOW_PRIVATE_HOSTS`](#let-the-hub-reach-services-on-your-lan).

Each user then picks which channels they personally want under **Settings → Notification preferences**. A channel is used if at least one user wants it, or if nobody has set preferences.

### Send a test alert
*Operator or admin.* There is no button for this yet. Call `POST /api/v1/alerts/test` from a signed-in session (with the same cookie and `Origin` header as in the channel example above). The response lists each channel's result.

### Tune CPU, memory and disk thresholds
*Operator or admin.* **Settings → Host thresholds.** Each metric has two levels:

- **Warn** (yellow): shown in the console and recorded in history, **no notification**.
- **Alarm** (red): opens an alarm and notifies.

Defaults: CPU 85/95%, memory 90/98%, disk 90/98%. A single disk rule covers every watched mount.

### Turn off a built-in rule
*Operator or admin.* `PATCH /api/v1/alerts/rules/<ruleId>` with `{"enabled": false}`. List rule IDs with `GET /api/v1/alerts/rules`.

### Mute or dismiss an alarm
*Operator or admin.* In **Alarms**:

- **Mute** 15 minutes, 30 minutes, 1 hour or 4 hours. This silences that exact alert identity (same rule, host and metric) until the time runs out.
- **Dismiss** one alarm, or select several and dismiss them together.

Alarms whose condition clears are marked **Recovered** automatically. You do not need to dismiss them.

### Set quiet hours
*Any user, for themselves.* **Settings → Notification preferences → Quiet hours.** Set start, end (the window may span midnight) and your timezone.

Non-critical notifications are held back only when **every** user who has quiet hours turned on is currently inside their window. **Critical alerts always go out.** Recovery notices are informational, so quiet hours suppress them.

### Pause all notifications
*Operator or admin.* **Alarms → Pause notifications**, or `POST /api/v1/alerts/pause`. Use it during maintenance. Nothing is sent while paused. Metric and log rules also stop opening **new** alarms, so a problem that starts during the pause shows up only once you resume (on the next sample that still breaches). Open alarms still auto-recover. To start the hub paused, set `HEIMDALL_ALERTS_PAUSED=true`.

For a narrower silence, prefer **Mute** on specific alarms.

The runtime pause is held in memory: it resets to the environment value when the hub restarts, and it applies only to the replica that received the request.

---

## Security

### Scan a host's packages and configuration
Install [Trivy](https://trivy.dev/) on the host. Then either run a one-off scan:

```bash
sudo heimdall-agent scan-host --hub https://<hub> --token <hdt_ token>
```

or schedule scans by adding this to `/etc/heimdall/agent.env` and restarting the agent:

```bash
HEIMDALL_HOST_POSTURE=1           # scans at start, then every 24h
HEIMDALL_TRIVY_BIN=/usr/local/bin/trivy
```

Results appear on the host page under **Security / Posture**. Full guide: [host-posture.md](../host-posture.md).

### Scan a container image
```bash
heimdall-agent scan-image --image nginx:1.27 --hub https://<hub> --token <token>
```
Findings appear under **Security** with source `trivy`.

### Import OSV-Scanner results
*Operator or admin, signed in.* Post the JSON report:

```bash
osv-scanner --format json -r . > osv.json
curl -X POST https://<hub>/api/v1/security/scan -H 'Content-Type: application/json' \
  -H 'Origin: https://<hub>' -b 'heimdall_session=…' \
  -d "{\"osvReport\": $(cat osv.json)}"
```

### Connect GitHub and GitLab
*Admin.* **Remotes → Add**: a GitHub organization (with a token that can read Dependabot and security advisories) or a GitLab project (with a token that can read vulnerabilities). For self-hosted GitLab, set the API base URL and allow its host with `HEIMDALL_ALLOW_PRIVATE_HOSTS`. To trigger a sync, `POST /api/v1/security/scan` with `{"syncRemotes": true}`.

### Receive Falco runtime events
*Admin.* **Settings → Integrations → Rotate runtime token**, then point Falco Sidekick at `https://<hub>/api/v1/integrations/runtime/webhook` with `Authorization: Bearer hdr_…`. Full guide: [runtime.md](../runtime.md).

### Turn critical findings into alarms
*Operator or admin.* **Settings → Critical findings → alarms**: on. Each **new** critical finding then opens an alarm and notifies.

---

## Observability

### Ship journald logs and host metrics with OpenTelemetry
1. *Admin:* **Settings → Integrations → Rotate OTEL token**, and copy the `hdo_…` token.
2. On the host:
   ```bash
   curl -fsSL https://<hub>/install.sh | sudo OTEL=1 LOG_UNITS=sshd.service,nginx.service bash
   ```
   Or add the collector only: `sudo env HUB_URL=… OTEL_TOKEN_FILE=… ./scripts/install-otelcol.sh`.
3. Journal lines appear under **Logs**.

For Docker hosts and Kubernetes (DaemonSet or sidecar), see [otel.md](../otel.md#install-one-command-per-target).

### Send application traces
Point your app's OpenTelemetry SDK at the **local collector**, not the hub:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318   # systemd/Docker host
OTEL_SERVICE_NAME=checkout-api
```

On Kubernetes, use `http://heimdall-otelcol.<namespace>:4318`. For third-party apps you cannot instrument (Plex, Jellyfin, …), enable Beyla: `--set otel.beyla.enabled=true`. Services then appear under **Services**.

### Receive UniFi alarms
*Admin.* **Settings → Integrations → Rotate UniFi token**. In UniFi Network → Alarm Manager, add a **Custom Webhook** action that sends `POST https://<hub>/api/v1/integrations/unifi/webhook` with a Bearer `hdu_…` token. Full guide: [unifi.md](../unifi.md).

---

## Accounts and access

### Enroll MFA
The first admin enrolls a **TOTP** authenticator in the wizard's MFA step and receives recovery codes. Keep the recovery codes: they are the way back in if you lose your device.

There is no account-settings screen for MFA yet. Factors are managed through the API:

- TOTP: `POST /api/v1/auth/mfa/totp/enroll` with `{"action":"start"}`, then confirm with a code.
- Passkeys (WebAuthn): `POST /api/v1/auth/mfa/webauthn/register/options`, then `…/register/verify`.

Replacing or adding a factor requires a session that has already passed MFA.

Passkeys require `HEIMDALL_RP_ID` (the hostname) and `HEIMDALL_ORIGIN` (the full origin) to match the URL in the browser. If you change the hub's hostname, users must enroll passkeys again.

### Add single sign-on (OIDC)
*Admin.*

1. In your IdP (Keycloak, Authentik, Okta, Google, Entra ID, …), create a confidential client with redirect URI `https://<hub>/api/v1/auth/oidc/callback`.
2. **Admin → Identity**: add the issuer URL, client ID, client secret and scopes (`openid email profile`).
3. The login page now shows a button for the provider.

New SSO users are created as **viewer**. A user whose email matches an existing account signs in as that account. Admins who have MFA enrolled still verify TOTP after SSO. Heimdall verifies ID token signatures against the IdP's JWKS and uses PKCE.

### Manage enrollment tokens
*Operator or admin.* **Settings → Agents.** For each token you can set a name, an expiry (TTL in hours) and a maximum use count. **Replace** issues a new token value and revokes the old one. **Revoke** stops new registrations. Neither action disconnects servers that are already installed, because they authenticate with their own per-agent secret.

### Lock down the bootstrap token
*Admin.* The bootstrap token (`HEIMDALL_BOOTSTRAP_TOKEN`) lets any agent register. After setup, go to **Settings → Agents → Bootstrap token** and either:

- **Disable** it (recommended), so new servers need an enrollment token; or
- **Rotate** it to a hub-generated `hdb_…` value.

If you get locked out, see the [bootstrap token runbook](../runbooks/bootstrap-token.md).

---

## Data

### Back up and restore
**Configuration** (*admin*): **Admin → Backup / restore → Export** downloads a JSON file with clusters, alert channels, rules, remotes and OIDC providers. Secrets are **redacted** unless you choose to include them. A file that includes secrets holds them in plaintext. **Restore** upserts the same items into the current org. User password hashes are not restored.

**Everything** (users, history, findings): back up Postgres with `pg_dump`, **and** keep `HEIMDALL_SECRET_KEY`. See [upgrading](upgrading.md#before-you-upgrade).

### Change data retention
*Operator or admin.* **Settings → Metric history retention.**

| Data | Default | Allowed |
| --- | --- | --- |
| Metric samples and OTel metrics | 60 days | 30–365 |
| Log events and closed alarms | 60 days | 30–365 |
| Traces | 7 days | 1–60 |

Old data is purged every 6 hours. Open alarms are never purged.

### Let the hub reach services on your LAN
To block SSRF, the hub refuses outbound requests to private, loopback and link-local addresses: IdPs, webhooks and GitHub/GitLab APIs. To allow a LAN service, set a narrow allowlist on the hub:

```bash
HEIMDALL_ALLOW_PRIVATE_HOSTS=gitlab.lan,keycloak.lan,203.0.113.20
```

Helm: `--set-string hub.extraEnv.HEIMDALL_ALLOW_PRIVATE_HOSTS=gitlab.lan`.
