# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

### Added
- First public release of the hub, the agent, the Helm chart and the Docker Compose stack.
- **Setup:** first-run wizard covering the admin account, alert channels, the first agent token, Git remotes and MFA.
- **Hosts:** CPU, memory, load and per-mount disk usage with warn and alarm bands, missing-mount alarms, and metric history charts (60-day default retention).
- **Containers:** Docker and Podman monitoring, with alarms for abnormal exits, OOM kills, restart loops and memory near the limit.
- **Kubernetes:** cluster health, exposed Services and NetworkPolicy coverage, and support for several clusters.
- **Security:** findings from Trivy (images and host posture), OSV-Scanner, GitHub, GitLab and Falco, plus optional alarms for new critical findings.
- **Logs:** agent file tailing and OpenTelemetry log ingest, with built-in threat rules and redaction of Heimdall tokens.
- **OpenTelemetry:** OTLP/HTTP JSON ingest for metrics, logs and traces; a Services (APM) page; a trace waterfall; collector configs and installers for systemd, Docker and Kubernetes; optional Grafana Beyla eBPF instrumentation.
- **Integrations:** UniFi Alarm Manager webhooks and Falco Sidekick webhooks.
- **Alerting:** email, Slack, Discord and SMS; mute, dismiss and bulk dismiss; quiet hours; global pause; automatic recovery notifications.
- **Access:** RBAC, TOTP, passkeys and recovery codes, and bring-your-own OIDC SSO.
- **Operations:** one-command host installer served by the hub, enrollment tokens with expiry and use limits, per-agent secrets with revoke and re-enroll, configuration backup and restore.
- **Hardening:** no shipped default credentials, AES-256-GCM encryption of stored secrets, rate limits and body caps, same-origin CSRF checks, and an SSRF guard on outbound requests.
