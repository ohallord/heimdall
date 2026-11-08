# Changelog

## Unreleased

### Added

- Private→public publish pipeline (`.publish/`, `scripts/publish.sh`) with fail-closed allowlist, replace map, denylist gates, and dry-run default.
- Guided server installer (`scripts/install.sh`) for Docker Compose and Helm values generation; re-runnable `configure`.
- Guided agent enrollment wrapper (`scripts/enroll-agent.sh`) that writes tokens via protected files and never accepts secret CLI args.
- Public README with architecture diagram, compose quick start, installer docs, and `TODO(Dan)` change notes.
- Bifrost Beacon brand (Concept B): SVG masters, PNG/ICO/OG assets, hub favicon/header/OG wiring.

### Security

- Publish push runs only with `PUBLISH_ALLOW_PUSH=1` and `PUBLIC_REPO_TOKEN`. A dry-run never pushes.
- Installers generate secrets into mode-0600 files and redact secrets from dry-run output.
