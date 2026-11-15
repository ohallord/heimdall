# Development

## Prerequisites

- Node.js 26+
- Go 1.22+
- Docker (optional, for Compose image builds)
- Helm 3 (optional, for chart lint/template)

## Monorepo layout

```
apps/hub      Next.js hub (App Router, PGlite/Postgres, Vitest)
apps/agent    Go agent
deploy/docker Compose stack
deploy/helm   Helm chart
e2e           Integration helpers
scripts       Smoke scripts
docs          Operator/dev docs
```

## Hub

```bash
cd apps/hub
npm ci
npm test
npm run lint
npm run build
```

Default test DB is PGlite (`HEIMDALL_DB_DRIVER=pglite`). PGlite is in memory and not shared across the hub's page and API bundles, so use Postgres (`DATABASE_URL`) when running a real `next start` instance, for example to capture screenshots. Schema: `apps/hub/db/schema.sql`.

## Agent

```bash
cd apps/agent
go test ./...
go build -o bin/heimdall-agent ./cmd/agent
```

## Conventions

- Conventional commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`).
- Prefer small focused commits per subsystem.
- Update `docs/phases/STATUS.md` at each phase boundary (private repo).
- The health endpoint's `phase` field is a legacy constant and does not track feature phases.
- Edit docs and the README in the private repo only. The public repo is a snapshot rebuilt by `scripts/publish.sh`; the public README is `.publish/PUBLIC_README.md`.
- Screenshots in `docs/screenshots/` must use synthetic data only (fake hosts, `example.com`, no real emails or IPs).

## Deploy docs

See [deploy.md](deploy.md) for Compose, Helm, OIDC callback, multi-cluster, remotes, and backup.
