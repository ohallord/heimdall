# Changelog

## Unreleased

### Fixed

- Container restart-loop alarms only fire for recent restarts.
- GitHub and GitLab security sync resolves findings that were closed upstream, syncs code scanning alerts (linked to the source line), and sends a `User-Agent` on GitHub requests.
- The MCP sign-in page is styled and accepts a username.
- The hub bundles IBM Plex so image builds no longer fetch Google Fonts.
- MCP tools follow the org that has an admin (or `HEIMDALL_ORG_ID`), and `heimdall_alerts` can filter by rule and host and returns open counts by rule.

### Added

- Synthetic uptime checks (HTTP, TCP, TLS certificate) run by the hub, with a Dashboard → Uptime page and `/api/v1/uptime`. See `docs/runbooks/uptime-checks.md`.
- Alert channels for ntfy, Pushover, Telegram and PagerDuty.
- Per-rule and org-wide alert sustain window: a breach must last before an alert opens.
- Audit log of administrative changes (Admin page, `/api/v1/admin/audit`). See `docs/runbooks/audit-log.md`.
- Scheduled GitHub and GitLab remote security sync per org (cron expression on Settings), following API pagination.
- Read-only MCP endpoint (including Grok sign-in) so AI assistants can query fleet status, alarms and findings. See `docs/runbooks/mcp-exposure.md`.
- Auto-release timer (`ops/auto-release/`) that deploys and publishes when code changes.
- Real, synthetic-data screenshots in the README and docs (`docs/screenshots/`).
- Private→public publish pipeline (`.publish/`, `scripts/publish.sh`) with fail-closed allowlist, replace map, denylist gates, and dry-run default.
- Guided server installer (`scripts/install.sh`) for Docker Compose and Helm values generation; re-runnable `configure`.
- Guided agent enrollment wrapper (`scripts/enroll-agent.sh`) that writes tokens via protected files and never accepts secret CLI args.
- Public README with architecture diagram, compose quick start, installer docs, and `TODO(Dan)` change notes.
- Bifrost Beacon brand (Concept B): SVG masters, PNG/ICO/OG assets, hub favicon/header/OG wiring.

### Security

- Publish push runs only with `PUBLISH_ALLOW_PUSH=1` and `PUBLIC_REPO_TOKEN`. A dry-run never pushes.
- Installers generate secrets into mode-0600 files and redact secrets from dry-run output.
