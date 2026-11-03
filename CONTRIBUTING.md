# Contributing to Heimdall

## Set up

Prerequisites: Node.js 22+, Go 1.22+ (CI uses 1.23), and optionally Docker with Compose v2.17+ and Helm 3.14+.

```bash
# Hub (uses embedded PGlite; no database needed)
cd apps/hub && npm ci
export HEIMDALL_BOOTSTRAP_TOKEN=$(openssl rand -hex 16)
HEIMDALL_SESSION_SECRET=heimdall-dev-session-secret-change-me!! \
HEIMDALL_PUBLIC_URL=http://127.0.0.1:43123 \
npm run dev -- --port 43123

# Agent, in another shell
cd apps/agent
go run ./cmd/agent run --hub http://127.0.0.1:43123 --token "$HEIMDALL_BOOTSTRAP_TOKEN" --hostname local-dev
```

Open <http://127.0.0.1:43123> and complete the setup wizard. More detail: [docs/development.md](docs/development.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/hub` | Next.js hub: UI, API, alerting (`src/lib/*`), schema (`db/schema.sql`) |
| `apps/agent` | Go agent (`cmd/agent`, `internal/*`) |
| `deploy/` | Compose, Helm chart, OTel collector configs, systemd units |
| `scripts/` | Installers, deploy and migration scripts, and their tests (`test-*.sh`) |
| `docs/` | User guide, reference, design, runbooks |

## Before you open a PR

Run what CI runs:

```bash
./scripts/check-no-default-token.sh
(cd apps/hub && npm run lint && npm test && npm run build)
(cd apps/agent && go test ./... && go build ./cmd/agent)
./scripts/handshake-smoke.sh
helm lint deploy/helm/heimdall --set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN=ci-test-token
```

If you changed installers or the chart, also run the matching `scripts/test-*.sh`.

## Conventions

- **Conventional commits:** `feat(scope):`, `fix(scope):`, `docs:`, `refactor:`, `test:`, `chore:`. Keep commits small and focused on one subsystem.
- **Tests come with the change.** Collectors, ingest, alert logic, parsers and UI contracts all get fixtures or tests in the same PR. Parser fixtures live next to the code (`src/lib/**/fixtures/`).
- **Schema changes are additive.** Add to `apps/hub/db/schema.sql` with `CREATE … IF NOT EXISTS` or `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. The hub applies the file on every start.
- **Security rules:**
  - Never ship a default credential (CI checks for this).
  - Never put a secret on a command line.
  - Store third-party secrets through the secrets helpers (`enc:v1:`).
  - Send outbound calls to admin-configured URLs through `safeFetch`.
  - Session routes that change state must use `mutating()` and `requireSession({ permission })`.
- **UI** follows [DESIGN.md](DESIGN.md): problems first, hairline borders, status dots, IBM Plex, one teal accent.
- **Docs:** user-visible changes update the [user guide](docs/user-guide/). New environment variables go in [configuration reference](docs/reference/configuration.md). New endpoints go in the [API reference](docs/reference/api.md).

- **Changelog:** add user-visible changes to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md).

## How pull requests land

This repository is published from the maintainer's working copy, so accepted pull requests are applied there and arrive here in the next sync. GitHub will show your PR as **closed** rather than merged, with a comment linking the commit that contains it. You stay credited as the commit author.

## Larger changes

For a new feature or a change in behaviour, open an issue first, so the approach can be agreed before you write a lot of code. Explain the problem, the proposed design, and what it means for existing installs (schema, configuration, agents). If the change rests on a significant design choice, add an entry to the [decision log](docs/design/decisions.md) in the same PR.

Product principles that guide reviews:

- Agents dial out; the hub never needs inbound access to hosts.
- Setup stays simple: the wizard plus Compose, Helm and standalone installs.
- Problems first in the UI, following [DESIGN.md](DESIGN.md).
- Configurable, with researched defaults.
- Trustworthy signals: fix false positives before adding alerting features on top.

## Code of conduct

Everyone taking part in this project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. By contributing, you agree that your contributions are licensed under it.
