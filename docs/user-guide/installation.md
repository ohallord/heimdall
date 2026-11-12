# Installation

Installing Heimdall has three parts:

1. **Run the hub** (once). Pick Docker Compose, Kubernetes (Helm), or your own Node.js process.
2. **Finish the first-run wizard** in the browser.
3. **Add servers.** Run one command on each host.

> Heimdall has no public image registry yet. Hub and agent images are built from this repository. The Compose file and `scripts/deploy-cluster.sh` do that for you.

## Requirements

| Piece | Requirement |
| --- | --- |
| Hub host | Docker with Compose v2.17+, **or** Kubernetes with Helm 3.14+, **or** Node.js 26+ |
| Database | PostgreSQL 16+. Compose and Helm include one. PGlite (embedded) is for development only |
| Agents | Linux with systemd, x86_64 or aarch64, outbound HTTP(S) to the hub |
| Network | Agents and integrations must reach the hub. The hub does **not** need to reach your hosts |
| Optional | [Trivy](https://trivy.dev/) for host posture and image scans; `otelcol-contrib` for OTel logs and metrics (the installer can download it) |

The hub listens on port **43123**.

## Choose an install path

| Path | Best for | Section |
| --- | --- | --- |
| Docker Compose | Trying Heimdall, a single server, small fleets | [Compose](#option-a-docker-compose) |
| Helm | A Kubernetes or k3s cluster you also want to monitor | [Helm](#option-b-kubernetes-helm) |
| Node.js process | Running the hub without containers | [Standalone hub](#option-c-standalone-hub) |

## Generate secrets first

Every path needs these values. Nothing secret ships with Heimdall: Compose refuses to start without them, and Helm generates the session secret and database password for you. Generate them and keep them somewhere safe, such as a password manager:

```bash
openssl rand -hex 32   # HEIMDALL_BOOTSTRAP_TOKEN – lets the first agents register; the setup wizard asks for it
openssl rand -hex 32   # HEIMDALL_SECRET_KEY      – encrypts stored secrets. BACK THIS UP.
openssl rand -hex 32   # HEIMDALL_SESSION_SECRET  – signs login cookies (Compose / standalone)
openssl rand -hex 24   # POSTGRES_PASSWORD        – database password (Compose)
```

**Back up `HEIMDALL_SECRET_KEY`.** It encrypts TOTP seeds, SSO client secrets, and alert and Git credentials in the database. If you lose it, those secrets cannot be recovered and must be re-entered.

Also decide your **public URL**: the exact address people type in the browser, such as `https://heimdall.example.com` or `http://203.0.113.10:43123`. Passkeys, SSO callbacks, CSRF protection and secure cookies all depend on it.

---

## Option A: Docker Compose

```bash
git clone <your heimdall repo> heimdall && cd heimdall/deploy/docker

cat > .env <<EOF
HEIMDALL_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
HEIMDALL_SECRET_KEY=$(openssl rand -hex 32)
HEIMDALL_SESSION_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
EOF
chmod 600 .env

docker compose up -d --build
```

This starts:

- **postgres**: PostgreSQL 16, data in the `heimdall_pg` volume, reachable from the Docker host only on `127.0.0.1:54329`
- **hub**: the console at <http://127.0.0.1:43123>
- **agent**: a sample agent named `compose-agent-01` that monitors the Docker host and its containers

Compose refuses to start if any required value is missing. The hub also refuses any session secret that has appeared in a published file.

**Before using Compose beyond your own machine**, set your public address. Put the values in a `compose.override.yaml` so `git pull` does not conflict:

```yaml
services:
  hub:
    environment:
      HEIMDALL_PUBLIC_URL: "https://heimdall.example.com"
      HEIMDALL_ORIGIN: "https://heimdall.example.com"
      HEIMDALL_RP_ID: "heimdall.example.com"
      HEIMDALL_COOKIE_SECURE: "true"
```

Optional profile: `docker compose --profile with-trivy up -d` adds an `agent-posture` service that scans the host filesystem with Trivy. See [host posture](../host-posture.md).

## Option B: Kubernetes (Helm)

The chart in `deploy/helm/heimdall` installs the hub, an in-cluster Postgres with a persistent volume, and an in-cluster agent with RBAC that watches the cluster and the node's disks.

### Build the images

On a single-node k3s server, the repository script builds both images, imports them into k3s, and deploys:

```bash
./scripts/deploy-cluster.sh          # build, import, helm upgrade, rollout, verify
```

For other clusters, build `apps/hub` and `apps/agent` with Docker, push them to your registry, and set `image.hub` and `image.agent`. Build the hub from the repository root context, because it bundles the agent binaries (see `deploy/docker/compose.yaml` for the `additional_contexts`).

### Install

```bash
kubectl create namespace heimdall
kubectl -n heimdall create secret generic heimdall-bootstrap \
  --from-literal=bootstrap-token="$(openssl rand -hex 32)"

helm upgrade --install heimdall deploy/helm/heimdall -n heimdall \
  --set hub.existingSecret.name=heimdall-bootstrap \
  --set-string hub.env.HEIMDALL_PUBLIC_URL=https://heimdall.example.com \
  --set-string hub.env.HEIMDALL_ORIGIN=https://heimdall.example.com \
  --set-string hub.env.HEIMDALL_RP_ID=heimdall.example.com \
  --set agent.clusterId=prod-a \
  --set image.hub=<registry>/heimdall-hub:<tag> \
  --set image.agent=<registry>/heimdall-agent:<tag>
```

Notes:

- The hub Service is `ClusterIP` on port 43123. Expose it with your Ingress, or change `hub.service.type`.
- The chart **generates `HEIMDALL_SECRET_KEY`** as Secret `heimdall-hub-secret-key` on first install and keeps it across upgrades and uninstalls. Back it up now:
  `kubectl -n heimdall get secret heimdall-hub-secret-key -o jsonpath='{.data.key}' | base64 -d`
- The chart also generates the **session secret and Postgres password** once, in Secret `heimdall-secrets`, and keeps them across upgrades. To bring your own, set `hub.sessionSecret.existingSecret` or `postgres.auth.password`.
- If you render with `helm template` (for example Argo CD), create these Secrets yourself and set `hub.secretKey.existingSecret` and `hub.sessionSecret.existingSecret`. Otherwise new values are generated on every render.
- Containers run as non-root with a read-only root filesystem and no Linux capabilities.
- To measure real host disk usage, set `agent.hostMounts.enabled=true` (or `-f deploy/helm/heimdall/values-host-mounts.yaml`). It mounts the host root read-only at `/host`. It is off by default because it exposes host files to the agent.
- Use a different `agent.clusterId` for each cluster.

The full list of chart values is in [configuration reference](../reference/configuration.md#helm-values).

## Option C: Standalone hub

Run the hub as a plain Node.js process against your own Postgres:

```bash
./scripts/build-dist.sh          # from the repo root: agent binaries + installers → apps/hub/dist
cd apps/hub && npm ci && npm run build

export NODE_ENV=production PORT=43123 HOSTNAME=0.0.0.0
export DATABASE_URL=postgres://heimdall:<pw>@db.example.com:5432/heimdall
export HEIMDALL_BOOTSTRAP_TOKEN=… HEIMDALL_SECRET_KEY=… HEIMDALL_SESSION_SECRET=…
export HEIMDALL_PUBLIC_URL=https://heimdall.example.com
export HEIMDALL_ORIGIN=https://heimdall.example.com HEIMDALL_RP_ID=heimdall.example.com
npm run start
```

The hub creates and migrates its schema on start. Put it behind a TLS reverse proxy, and set `HEIMDALL_TRUST_PROXY=1` so rate limits see real client IPs.

---

## First-run wizard

Open the public URL. A fresh hub sends you to `/setup`, which has five steps:

1. **Admin.** Create the organization and the first admin account (email and password). Enter the hub's `HEIMDALL_BOOTSTRAP_TOKEN` as the setup token. This proves you operate the hub, so a stranger who reaches a fresh hub first cannot claim it. Only one first admin can be created.
2. **Alerts.** Optionally configure notification channels: SMTP email, Slack webhook, Discord webhook, and SMS (Twilio-compatible account SID, auth token, from and to numbers). You can skip this step.
3. **Agent.** Mint an agent token and copy the install snippet.
4. **Remotes.** Optionally connect a GitHub organization and a GitLab project for security findings. You can add more later under **Remotes**.
5. **MFA.** Enroll an authenticator app (TOTP), and save your recovery codes somewhere safe.

Once the wizard finishes, you land on the **Fleet** page.

## Add servers

The recommended way to add a host is the one-command installer the hub serves.

1. Go to **Settings → Agents → + Add a server**. The defaults create a token for 1 server that expires in 24 hours.
2. Copy the command shown. The token appears only once.
3. On the server, run:

   ```bash
   curl -fsSL https://heimdall.example.com/install.sh | sudo bash
   ```

   Paste the `hdt_…` token when prompted.

   The installer requires `https://` because it downloads binaries that run as root. On a trusted LAN with a plain-http hub, the command shown in the console adds `HEIMDALL_ALLOW_INSECURE=1`. To pin the binary independently of the hub, pass `EXPECTED_SHA256=<sha256>`.

The installer:

- downloads the right agent binary (amd64 or arm64) from the hub and checks it against the hub's `SHA256SUMS`;
- creates a `heimdall` system user and `/var/lib/heimdall` for agent state;
- writes `/etc/heimdall/agent.env` and installs and starts the `heimdall-agent` systemd unit;
- adds the agent user to the `docker` group if one exists, so container metrics work (pass `DOCKER=0` to skip this).

The host appears under **Fleet → Servers** within about 10 seconds.

### Installer variants

```bash
# Also install the OpenTelemetry collector (journald logs + host metrics); prompts for an hdo_ token
curl -fsSL https://<hub>/install.sh | sudo OTEL=1 bash

# Non-interactive, reading the token from a file (keeps it out of logs)
curl -fsSL https://<hub>/install.sh | sudo TOKEN_FILE=/root/hdt.txt bash

# Preview only: download and verify, print the steps, change nothing
curl -fsSL https://<hub>/install.sh | sudo DRY_RUN=1 bash

# Uninstall (PURGE=1 also deletes /var/lib/heimdall)
curl -fsSL https://<hub>/install.sh | sudo bash -s -- --uninstall
```

Other pass-through options: `HOSTNAME_VALUE`, `CLUSTER_ID`, `ENABLE_K8S`, `LOG_UNITS`, `LOG_PATHS`, `OTELCOL_BIN`.

Avoid `sudo TOKEN=hdt_… bash` on shared machines. The token becomes part of sudo's command line, which systemd-journald records.

### Other ways to run an agent

| Situation | How |
| --- | --- |
| Host where the hub cannot serve binaries | Build with `go build ./cmd/agent` in `apps/agent`, then `HUB_URL=… TOKEN=… ./scripts/install-agent.sh` |
| Kubernetes cluster | The Helm chart's in-cluster agent (one per cluster, unique `agent.clusterId`) |
| Docker-only host | Run the `heimdall-agent` image with `/var/run/docker.sock` and a volume at `/var/lib/heimdall` (see `deploy/docker/compose.yaml`) |

Whatever the method, **the agent's state directory (`/var/lib/heimdall`) must survive restarts.** It holds the agent's secret. If it is lost, the hub refuses the agent with `409 hostname_in_use` until an admin clicks **Re-enroll**.

## Verify the install

```bash
curl -s https://heimdall.example.com/api/v1/health
# {"status":"ok","service":"heimdall-hub",…}

sudo systemctl status heimdall-agent
journalctl -u heimdall-agent -n 50
```

In the console, the host should show a green dot under **Fleet → Servers**, with CPU, memory and disk values.

## Production checklist

- [ ] `HEIMDALL_SESSION_SECRET` is random (`openssl rand -hex 32`); Helm generates one for you
- [ ] `HEIMDALL_SECRET_KEY` is set and **backed up** separately from database backups
- [ ] `HEIMDALL_PUBLIC_URL` uses `https://` and matches the browser URL
- [ ] `HEIMDALL_TRUST_PROXY` is set only if a reverse proxy you control sits in front
- [ ] Postgres data is on a persistent volume and backed up (`pg_dump`)
- [ ] Every admin has MFA enrolled
- [ ] After all agents are enrolled, the bootstrap token is **disabled** in Settings → Agents
- [ ] Once no agent shows a `legacy token` badge, the hub runs with `HEIMDALL_LEGACY_TOKENS=off`
- [ ] A redacted configuration backup has been exported from **Admin → Backup**

## Next steps

- [Features tour](features.md)
- [Set up alert notifications](how-to.md#configure-alert-channels)
- [Ship logs and traces with OpenTelemetry](../otel.md)
