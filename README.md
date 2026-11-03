# Heimdall

**Self-hosted monitoring and security console for small fleets.** One hub and lightweight agents that only dial out. Heimdall watches your servers, containers and Kubernetes clusters, gathers security findings, logs, OpenTelemetry traces and network events, and tells you when something needs attention.

Built for home labs, small teams and on-prem servers that want one operator console instead of five tools.

> **Status: early (0.x).** Heimdall runs in production on its maintainers' own infrastructure. Expect rough edges and breaking changes before 1.0. Read the [known limitations](docs/design/security-model.md#known-limitations) before exposing a hub to the internet.

## Why "Heimdall"?

In Norse mythology, Heimdall is the watchman of the gods. He stands guard at Bifröst, the rainbow bridge into Asgard, and is said to need less sleep than a bird. He can see a hundred leagues by day or night, and his hearing is so keen he can hear grass growing and wool growing on a sheep. When danger comes, he sounds the Gjallarhorn to warn the gods.

That's the job this project does for your infrastructure:

- **The watchman that never sleeps.** Agents report every few seconds, around the clock, from every server, container and cluster.
- **Sees across every realm.** Bare-metal hosts, Docker and Podman, Kubernetes, the network and your Git hosting all show up in one console.
- **Hears the grass grow.** Log threat rules pick out failed SSH logins, sudo abuse, reverse shells and crypto miners in the noise.
- **Guards the bridge.** Agents dial out over a single authenticated path, each with its own secret, so the hub never has to reach into your hosts.
- **Sounds the horn.** When something breaks, Heimdall alerts you by email, Slack, Discord or SMS, and tells you again when it recovers.

## Features

- **Servers:** CPU, memory, load and per-mount disk usage with warn and alarm bands; missing-mount detection; 60 days of metric history
- **Containers:** Docker and Podman state, restarts, OOM kills, memory against the limit; alarms only for abnormal exits
- **Kubernetes:** API reachability, node readiness, pending and crash-looping pods, unhealthy deployments, exposed Services, NetworkPolicy coverage; several clusters per hub
- **Security findings:** Trivy (images and host posture), OSV-Scanner, GitHub Dependabot and advisories, GitLab vulnerabilities, and Falco runtime events in one list
- **Logs:** agent file tail or OpenTelemetry journald/filelog, with built-in threat rules (SSH brute force, sudo abuse, reverse shells, crypto miners, webshells, privilege escalation)
- **APM:** OpenTelemetry traces with rate, errors and p50/p95 per service, a span waterfall, and optional eBPF auto-instrumentation (Grafana Beyla) for apps you cannot change
- **Network:** UniFi Alarm Manager webhooks, grouped by category and device
- **Alerting:** email, Slack, Discord and SMS (Twilio-compatible); mute, dismiss, quiet hours, global pause, automatic "recovered" notices
- **Access:** RBAC (admin, operator, viewer), TOTP and passkeys, bring-your-own OIDC SSO
- **Secure by default:** no default credentials, per-agent secrets, secrets encrypted at rest, rate limits, CSRF and SSRF protection

## How it works

```
 hosts:  heimdall-agent ─┐   (outbound HTTPS only)
         otelcol ────────┼──►  Heimdall hub (web UI + API)  ──► PostgreSQL
 UniFi / Falco webhooks ─┘            │
                                      └──► Email · Slack · Discord · SMS
```

The **hub** is a Next.js app backed by PostgreSQL. The **agent** is a single static Go binary for linux/amd64 and linux/arm64. Agents register once with an enrollment token, then authenticate with their own secret. The hub never connects to your hosts. Details: [system design](docs/design/system-design.md).

## Quick start (Docker Compose)

```bash
git clone https://github.com/ohallord/heimdall.git
cd heimdall/deploy/docker

cat > .env <<EOF
HEIMDALL_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
HEIMDALL_SECRET_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env

docker compose up -d --build
```

Open <http://127.0.0.1:43123>. The setup wizard creates your admin account. Then add a server from **Settings → Agents → + Add a server**, which gives you a one-line installer:

```bash
curl -fsSL http://<hub>:43123/install.sh | sudo bash
```

The Compose defaults are for local use only. Before exposing a hub, follow the [installation guide](docs/user-guide/installation.md). It also covers Kubernetes (Helm) and running without containers.

## Documentation

Start at **[docs/README.md](docs/README.md)**.

- **Using Heimdall:** [Overview](docs/user-guide/overview.md) · [Installation](docs/user-guide/installation.md) · [Upgrading](docs/user-guide/upgrading.md) · [Features](docs/user-guide/features.md) · [How-to guides](docs/user-guide/how-to.md) · [Troubleshooting](docs/user-guide/troubleshooting.md)
- **Reference:** [Configuration](docs/reference/configuration.md) · [Agent CLI](docs/reference/agent-cli.md) · [HTTP API](docs/reference/api.md)
- **Design:** [System design](docs/design/system-design.md) · [Agent](docs/design/agent.md) · [Alerting](docs/design/alerting.md) · [Security model](docs/design/security-model.md) · [Data model](docs/design/data-model.md) · [Decisions](docs/design/decisions.md)

## Development

```bash
# Hub, with embedded PGlite (no database needed)
export HEIMDALL_BOOTSTRAP_TOKEN=$(openssl rand -hex 16)
cd apps/hub && npm ci
HEIMDALL_SESSION_SECRET=heimdall-dev-session-secret-change-me!! \
HEIMDALL_PUBLIC_URL=http://127.0.0.1:43123 \
npm run dev -- --port 43123

# Agent, in a second shell
cd apps/agent
go run ./cmd/agent run --hub http://127.0.0.1:43123 --token "$HEIMDALL_BOOTSTRAP_TOKEN" --hostname local-dev
```

No token is shipped. For throwaway local runs only, `HEIMDALL_DEV=1` makes the hub accept the well-known dev token `heimdall-dev-token` when `HEIMDALL_BOOTSTRAP_TOKEN` is unset. It is ignored when `NODE_ENV=production`.

Tests: `cd apps/hub && npm test` · `cd apps/agent && go test ./...` · `./scripts/handshake-smoke.sh`

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[Apache License 2.0](LICENSE)
