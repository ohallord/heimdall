# Migrate Heimdall from Docker Compose to Kubernetes

Use this guide to move a running Compose install (hub, Postgres and sample agent) to the Helm chart, with an in-cluster agent and Postgres on a persistent volume. It is written for single-node k3s hosts that already run the Compose stack, but the steps apply to any cluster.

**Script:** [`scripts/migrate-compose-to-k8s.sh`](../scripts/migrate-compose-to-k8s.sh)

```bash
# from your clone of the repository
./scripts/migrate-compose-to-k8s.sh --help

# The URL you will open in a browser (LAN IP or hostname + exposed port), NOT Service DNS
export PUBLIC_URL='http://192.0.2.10:43123'
export SESSION_SECRET='<at least 32 characters>'
export BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
# optional: CLUSTER_ID, IMAGE_HUB / IMAGE_AGENT, SKIP_IMAGE_IMPORT=1, HELM_RESET=1, HUB_NODEPORT

./scripts/migrate-compose-to-k8s.sh preflight
./scripts/migrate-compose-to-k8s.sh all
# or step by step: export → images → install → restore → cutover
# helm --wait stuck?     ./scripts/migrate-compose-to-k8s.sh status
# partial release?       ./scripts/migrate-compose-to-k8s.sh install --reset
```

## Steps (the script mirrors these)

1. `preflight`: checks kubectl, helm, a healthy Compose stack, the chart, and whether port 43123 is free.
2. `export`: `pg_dump` of the Compose database, plus an optional configuration backup over HTTP.
3. `images`: `docker compose build hub agent`, then import into k3s containerd (`docker save … | sudo k3s ctr images import -`).
4. `install`: `helm upgrade --install` with the local images and `pullPolicy: IfNotPresent`. `--reset` (or `HELM_RESET=1`) uninstalls first.
5. `restore`: loads the dump into the cluster Postgres.
6. `cutover`: checks hub health, reminds you to activate the cluster in the UI, and stops Compose hub and Postgres.
7. `host-agent` (optional): prints how to keep a Compose agent for Docker monitoring, pointed at the new hub URL.
8. `status`: pods, services, PVCs and recent events, for debugging.

## What moves

| Piece | Where it lives in Compose | How it moves |
| --- | --- | --- |
| Users, orgs, MFA, agents, history, rules, alarms | Postgres volume `heimdall_heimdall_pg` | `pg_dump` → restore into the Helm Postgres PVC |
| Channels, remotes, SSO providers | Same database (and optionally the admin backup JSON) | Database restore, or Admin **Backup** with `includeSecrets=1` |
| Session secret, bootstrap token, public URL | Compose environment | Helm values (`--set`) |
| `HEIMDALL_SECRET_KEY` | `deploy/docker/.env` | **Must be carried over** (`hub.secretKey.existingSecret` or `hub.env.HEIMDALL_SECRET_KEY`), or stored secrets cannot be decrypted |
| Docker host monitoring | Compose agent + `docker.sock` | Keep a host agent (`install.sh` or the Compose agent) |
| Kubernetes monitoring | Off in Compose | In-cluster agent with RBAC and `enableK8s=true` |

## Things to get right

1. **Public URL.** Use the URL you open in a browser, such as `http://192.0.2.10:43123`. Do **not** use `http://heimdall-hub:43123`; that is cluster-internal DNS, and it breaks MFA, cookies and the origin check. Keep `HUB_NODEPORT` (default `43123`) aligned with that port, or use something like `30431` if your cluster's NodePort range rejects low ports. If the hostname changes, passkeys must be enrolled again.
2. **Local images.** k3s has its own containerd, so images built by Docker must be imported (`images` step). `SKIP_IMAGE_IMPORT=1` skips the build and import when they are already loaded. `ImagePullBackOff` usually means this step was skipped.
3. **Port clash.** The Compose hub holds `:43123`. Stop it (`docker compose stop hub`) before cutover. The script warns if the port is busy.
4. **Two writers.** After cutover, stop Compose Postgres too, so nothing writes to the old database.
5. **Host disk mounts.** The chart mounts the host root at `/host` and watches `/host` and `/host/var`. To change the list, use a values file or indexed `--set agent.hostMounts.watchMounts[0]=…`. Never pass a comma-joined string to `--set`, because Helm splits on commas. See [deploy.md](deploy.md#in-cluster-agent-host-disk-mounts).
6. **Kubernetes monitoring.** Do not just flip `HEIMDALL_ENABLE_K8S=true` on the Compose agent. Use the in-cluster agent that this migration installs.

## Rollback

Leave the Compose volume untouched until you have confirmed that login and the Fleet page work in the cluster. To go back, run `docker compose up -d` in `deploy/docker`, and point DNS or the URL back if you changed them.

See also [deploy.md](deploy.md) and [upgrading](user-guide/upgrading.md).
