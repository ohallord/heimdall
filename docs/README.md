# Heimdall documentation

Heimdall is a self-hosted monitoring hub with lightweight outbound agents. It watches hosts, containers and Kubernetes clusters, and it collects security findings, logs, OpenTelemetry metrics and traces, and network events. It all shows up in one operator console with alerting.

Start with the section that matches what you are doing.

## User guide: install and operate Heimdall

| Document | Read it when you want to… |
| --- | --- |
| [Overview and concepts](user-guide/overview.md) | Understand what Heimdall is, its parts, and its vocabulary |
| [Installation](user-guide/installation.md) | Stand up a hub (Compose, Helm or standalone) and add your first servers |
| [Upgrading](user-guide/upgrading.md) | Update the hub and agents safely, and roll back |
| [Features tour](user-guide/features.md) | Learn what each screen in the console does |
| [How-to guides](user-guide/how-to.md) | Do a specific task: alerts, MFA, SSO, OTel, backups and more |
| [Troubleshooting](user-guide/troubleshooting.md) | Fix a symptom you are seeing |

Integration guides (detailed, per feature):
[OpenTelemetry](otel.md) · [UniFi](unifi.md) · [Runtime threats (Falco)](runtime.md) · [Host posture (Trivy)](host-posture.md) · [Network security](network-security.md) · [Compose → Kubernetes migration](migrate-compose-to-k8s.md)

Deployment deep dive: [deploy.md](deploy.md) (every install path, request protection, secrets at rest, outbound SSRF guard).

## Reference

| Document | Contents |
| --- | --- |
| [Configuration](reference/configuration.md) | Every hub and agent environment variable, plus the main Helm values |
| [Agent CLI](reference/agent-cli.md) | `heimdall-agent` commands and flags |
| [HTTP API](reference/api.md) | Every endpoint, with its auth method and required permission |
| [Glossary](glossary.md) | Terms and token prefixes |

## Design

| Document | Contents |
| --- | --- |
| [System design](design/system-design.md) | Components, data flows, deployment topologies |
| [Agent design](design/agent.md) | The run loop, collectors, identity and state |
| [Alerting design](design/alerting.md) | Rules, bands, fingerprints, cooldown, mute, quiet hours, recovery |
| [Security model](design/security-model.md) | Trust boundaries, credentials, sessions, encryption, SSRF |
| [Data model](design/data-model.md) | Tables, ownership and retention |
| [Architecture decisions](design/decisions.md) | Key decisions and why they were made |
| [UI design system](../DESIGN.md) | Visual language for the console |
| [Security review](security-review.md) | STRIDE review, findings and dispositions |

## Operations

Runbooks for specific incidents live in [`runbooks/`](runbooks/):
[bootstrap and enrollment tokens](runbooks/bootstrap-token.md) · [security hardening symptoms](runbooks/security-hardening.md) · [Postgres recovery](runbooks/postgres-recovery.md) · [Helm upgrade with new values](runbooks/helm-upgrade-new-values.md)

## Contributing

[Development setup](development.md) · [Contributing guide](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) · [Security policy](../SECURITY.md) · [Changelog](../CHANGELOG.md)
