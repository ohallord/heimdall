# Overview and concepts

Heimdall is a self-hosted monitoring and security console for small-to-medium fleets: home labs, small teams, and on-prem servers. You run one **hub**. Every machine you want to watch runs a small **agent** that dials out to the hub. The hub never connects in to your hosts.

```
            ┌────────────── your hosts ──────────────┐
            │  heimdall-agent   heimdall-agent   …   │──┐  HTTPS, outbound only
            │  otelcol (optional)                    │  │
            └────────────────────────────────────────┘  │
 UniFi console ──webhook──┐                             ▼
 Falco / Sidekick ─webhook┼──────────────────►  Heimdall hub  ──► Postgres
 GitHub / GitLab ◄──sync──┘                     (web UI + API)
                                                     │
                                         Email · Slack · Discord · SMS
```

## What it monitors

| Area | Source | What you get |
| --- | --- | --- |
| **Servers** | Agent | CPU, memory, load, disk per mount, missing mounts, metric history charts |
| **Containers** | Agent (Docker or Podman socket) | State, restarts, OOM kills, CPU and memory against the limit |
| **Kubernetes** | Agent with K8s enabled | API reachability, node readiness, pending and crash-looping pods, unhealthy deployments, exposed Services, NetworkPolicy coverage |
| **Logs** | Agent file tail, or OTel journald/filelog | Searchable log lines, plus built-in threat rules (SSH brute force, sudo abuse, reverse shells, miners, webshells, privilege escalation) |
| **Security findings** | Trivy, OSV-Scanner, GitHub, GitLab, Falco | One findings list with severity, status and source |
| **Host posture** | Trivy `rootfs` on the host | OS package CVEs and misconfigurations per host |
| **APM** | OpenTelemetry traces (SDKs or eBPF via Beyla) | Services with rate, errors, p50/p95, and trace waterfalls |
| **Network** | UniFi Alarm Manager, K8s exposure | Grouped network events and exposure summary |

Alerts go to **email (SMTP), Slack, Discord and SMS** (Twilio-compatible), with mute, dismiss, quiet hours, a global pause switch, and "recovered" notices.

## Core concepts

**Hub.** A Next.js web app plus HTTP API, backed by PostgreSQL (or embedded PGlite for development). It stores everything, evaluates alert rules, and serves the console, the agent binaries and the host installer.

**Agent.** A single static Go binary, `heimdall-agent`. One binary covers host metrics, containers and Kubernetes. Which collectors run depends on what the agent can see. The agent registers once, stores a per-agent secret on disk, then pushes a sample every 10 seconds by default.

**Organization.** All data belongs to an organization. The first-run wizard creates one. Heimdall is built as a single-tenant self-hosted product today.

**Cluster.** Agents and Kubernetes snapshots carry a `cluster_id` (default `default`). You can register several clusters and pick which one the fleet Kubernetes summary shows.

**Users and roles.** Three roles:

| Role | Can |
| --- | --- |
| `viewer` | See everything in the org |
| `operator` | Everything a viewer can, plus manage agents and enrollment tokens, mute and dismiss alarms, tune alert rules and thresholds, triage findings |
| `admin` | Everything, plus settings, integrations, SSO providers, clusters, backup and restore, bootstrap token |

The wizard creates the first admin. Users who sign in through SSO (OIDC) are created as `viewer`. There is no in-app screen for inviting local users or changing roles yet.

**Tokens.** Heimdall uses several kinds of credential, each with a recognizable prefix:

| Prefix | Name | Used by | Created in |
| --- | --- | --- | --- |
| `hdt_` | Enrollment token | New agents, at registration only | Settings → Agents → **+ Add a server** |
| `hda_` | Agent secret | One agent, for all its traffic after registration | Minted automatically at registration; stored in the agent's state directory |
| `hdb_` | Rotated bootstrap token | Agents registering with the hub-wide bootstrap token | Settings → Agents (bootstrap section) |
| `hdo_` | OTel ingest token | OpenTelemetry collectors | Settings → Integrations |
| `hdu_` | UniFi webhook token | UniFi Alarm Manager | Settings → Integrations |
| `hdr_` | Runtime webhook token | Falco Sidekick | Settings → Integrations |

The hub stores only hashes of these tokens. Each one is shown once when created. See the [security model](../design/security-model.md) for details.

**Alarms.** When a sample crosses a rule's threshold, the hub opens an alert event. Host CPU, memory and disk rules have two bands: **warn** (yellow, recorded only) and **alarm** (red, notifies). Open alarms clear themselves when the metric recovers.

## What Heimdall is not

- Not a Prometheus or Grafana replacement. There is no query language. Charts are fixed per metric.
- Not a UniFi controller. It receives UniFi alarms; it does not manage the network.
- Not a cloud security posture manager. Findings come from scanners you run or connect.
- Falco and eBPF are optional add-ons, not requirements.

## Next steps

- [Install Heimdall](installation.md)
- [Take the features tour](features.md)
