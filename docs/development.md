# Development

## Prerequisites

- Node.js 22+
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

Default test DB is PGlite (`HEIMDALL_DB_DRIVER=pglite`). Schema: `apps/hub/db/schema.sql`.

## Agent

```bash
cd apps/agent
go test ./...
go build -o bin/heimdall-agent ./cmd/agent
```

## Conventions

- Conventional commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`).
- Prefer small focused commits per subsystem.
- Additive schema changes only (`IF NOT EXISTS`); the hub applies `db/schema.sql` on start.
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full checklist.

## Deploy docs

See [deploy.md](deploy.md) for Compose, Helm, OIDC callback, multi-cluster, remotes, and backup.
