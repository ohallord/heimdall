# Migrate Heimdall: Docker Compose → Kubernetes

For homelab (Compose hub + Postgres + `compose-agent-01` today → full Helm in-cluster). Still being tested — script is intentionally a bit messy/complete.

**Script:** [`scripts/migrate-compose-to-k8s.sh`](../scripts/migrate-compose-to-k8s.sh)

```bash
cd /path/to/heimdall   # or your clone
./scripts/migrate-compose-to-k8s.sh --help

# Browser URL (LAN IP + exposed port) — NOT Service DNS like http://heimdall-hub:43123
export PUBLIC_URL='http://203.0.113.10:43123'
# optional: SESSION_SECRET (empty = chart-generated); POSTGRES_PASSWORD (empty = generated)
# BACKUP_DIR: export creates a private mktemp dir and prints it; export it again for restore
# optional: IMAGE_HUB / IMAGE_AGENT / SKIP_IMAGE_IMPORT=1 (or SKIP_IMAGE_BUILD=1) / HELM_RESET=1 / HUB_NODEPORT

./scripts/migrate-compose-to-k8s.sh preflight
./scripts/migrate-compose-to-k8s.sh all
# or stepwise: export → images → install → restore → cutover
# stuck helm --wait? → ./scripts/migrate-compose-to-k8s.sh status
# partial release? → HELM_RESET=1 ./scripts/migrate-compose-to-k8s.sh install
#                 or ./scripts/migrate-compose-to-k8s.sh install --reset
```

## homelab learnings (local images + URL)

1. **Import images into k3s** — Compose builds into Docker; k3s uses its own containerd. `images` runs `docker compose build hub agent` then `docker save … | sudo k3s ctr images import -` for `heimdall-hub:latest` / `heimdall-agent:latest` (override with `IMAGE_HUB` / `IMAGE_AGENT`). Plain docker/kind may skip import; `SKIP_IMAGE_IMPORT=1` or `SKIP_IMAGE_BUILD=1` skips **both** compose build and import when images are already loaded. `install` / `all` call `images` before helm.
2. **Helm local images** — chart keys are full refs + policy: `image.hub`, `image.agent`, `image.pullPolicy=IfNotPresent` (see [`values.yaml`](../deploy/helm/heimdall/values.yaml)).
3. **PUBLIC_URL** — use the URL you open in a browser (e.g. `http://203.0.113.10:43123`). Do **not** use `http://heimdall-hub:43123` (cluster DNS only; breaks MFA/cookies/ORIGIN). Keep `HUB_NODEPORT` (default `43123`) aligned with that port, or use `30431` if your cluster’s NodePort range rejects low ports.
4. **Port clash** — Compose hub holds `:43123`. Before/during cutover: `docker compose stop hub` (and `postgres` after restore). Script warns if something is listening on 43123.
5. **Debug** — `status` dumps `pods,svc,pvc,events` when `helm --wait` hangs (ImagePullBackOff = forgot `images`).
6. **Host disk mounts** — chart default `agent.hostMounts.enabled=true` mounts host `/` → `/host` (readOnly) and sets `HEIMDALL_WATCH_MOUNTS` from the YAML list `agent.hostMounts.watchMounts: [/host]` (must-present list; the agent discovers the other host filesystems for display). Compose still uses `HEIMDALL_WATCH_MOUNTS: /` on the host agent. After chart upgrade: `helm upgrade --reuse-values … --set agent.hostMounts.enabled=true` (defaults are enough). To override paths, use a `-f` values file or `--set agent.hostMounts.watchMounts[0]=…` — never a comma-joined `--set`/`--set-string` (Helm splits on `,`). See [deploy.md](deploy.md).

Helm `--set` also matches `hub.env.HEIMDALL_*` (including `ORIGIN`) and `agent.{clusterId,hostname,enableK8s,hostMounts.*}`. Cookie Secure is derived from the `PUBLIC_URL` scheme.

## What moves

| Piece | Where it lives (Compose) | How it moves |
| --- | --- | --- |
| Users, orgs, MFA, agents, samples, alert rules/history | Postgres volume `heimdall_heimdall_pg` | `pg_dump` → restore into Helm Postgres PVC |
| SMTP / Slack / Discord / SMS / remotes / OIDC | Same DB (+ optional Admin backup JSON) | DB restore; or Admin **Backup** with `includeSecrets=1` |
| Session / bootstrap / public URL | Compose env | Helm `values` / `--set` (must match browser URL) |
| Docker host monitoring | Compose agent + docker.sock | Keep a host agent **or** DaemonSet later; in-cluster agent is for K8s API |
| K8s monitoring | Off (`k8s=false`) on Compose agent | In-cluster agent with RBAC + `enableK8s=true` |

## Important decisions

1. **Public URL** must be the browser URL (LAN IP / hostname + port matching NodePort/hostPort/Ingress). Re-enroll passkeys if RP ID changes.
2. **Do not** only flip Compose `HEIMDALL_ENABLE_K8S=true` — deploy the cluster agent (this migration).
3. After cutover, stop Compose hub/postgres to avoid two writers **and** free `:43123`. Optionally keep a **host** agent for Docker metrics with hub URL = `PUBLIC_URL`.

## Phases (script mirrors these)

1. `preflight` — kubectl, helm, compose healthy, chart present, port-clash hint  
2. `export` — pg_dump + optional HTTP backup JSON  
3. `images` — build + import into k3s/containerd  
4. `install` — Helm upgrade (local images + IfNotPresent); `--reset` / `HELM_RESET=1` uninstalls first  
5. `restore` — load dump into cluster Postgres  
6. `cutover` — verify health, activate cluster in UI, stop Compose hub/postgres  
7. `host-agent` (optional) — leave Docker monitoring via host/`compose` agent → new hub URL  
8. `status` — pods/svc/pvc/events for debugging  

## Rollback

Keep the Compose volume untouched until you confirm Fleet + login work in-cluster.  
`docker compose up -d` in `deploy/docker` brings the old stack back; point DNS/URL back if you changed it.

See also [deploy.md](deploy.md) for general Compose/Helm install notes.
