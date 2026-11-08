# Architecture (Phase 8)

Heimdall uses a **hub + outbound agents** model.

```
Agent  --HTTP register-------------->  Hub API
Agent  --HTTP metrics+containers+k8s+logs+vulns-->  Hub API  -->  Postgres / PGlite
Browser -- session cookie / OIDC --->  Hub UI / dashboard
Alert engine -- SMTP / Slack / Discord / SMS (Twilio-compatible)
GitHub / GitLab remotes (N) ------->  Hub security sync
BYO IdP (OIDC) -------------------->  Hub auth callback
```

## Handshake + host metrics (Phase 2)

1. Agent registers, then scrapes CPU/memory/load/disk/mounts.
2. `POST /api/v1/agents/metrics` stores samples and refreshes `last_seen_at`.
3. Fleet UI marks agents online within ~45s of last ingest.

## Containers (Phase 3)

1. Agent detects Docker or Podman via unix socket (Engine API compatible).
2. Lists containers (`/containers/json?all=1`), inspects restart/OOM/exit, and pulls stats when running for CPU% and memory vs cgroup limit.
3. Container snapshots ride along on the same metrics ingest payload (`containers`, `containerRuntime`).
4. Hub persists `agent_containers_latest` and evaluates `container_exited` (per container, only when it stops abnormally while monitored), `container_oom`, `container_restart_loop`, `container_mem_limit_pct`.
5. Dashboard shows a fleet-wide container table; host detail includes per-host containers.

If no runtime socket is present, the agent still ships host metrics with `containerRuntime: "none"`.

## Auth and setup (Phase 1 + 8)

- First-run wizard, RBAC, MFA (TOTP + passkeys) as before.
- Phase 8: BYO OIDC providers; login lists enabled IdPs; new SSO users default to `viewer`.
- Install snippets default to long-running `heimdall-agent run`.

## Multi-cluster (Phase 8)

- Agents and K8s snapshots carry `cluster_id` (default `default`).
- `clusters` + `org_settings.active_cluster_id` drive the fleet K8s summary.
- UI: `/dashboard/clusters` activate / register; APIs under `/api/v1/clusters`.

## Remotes & backup (Phase 8)

- `security_connections` supports N GitHub orgs and GitLab projects.
- Org config backup v1 JSON via `/api/v1/admin/backup` (secrets redacted by default).
