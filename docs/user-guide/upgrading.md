# Upgrading

Heimdall upgrades in place. The hub applies its database schema changes automatically at startup. Every schema change is additive (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so there is no separate migration step.

## Before you upgrade

1. **Back up the database.**
   - Compose: `docker compose exec postgres pg_dump -U heimdall -Fc heimdall > heimdall-$(date +%F).dump`
   - Helm: `kubectl -n heimdall exec deploy/heimdall-postgres -- pg_dump -U heimdall -Fc heimdall > heimdall-$(date +%F).dump`
2. **Confirm you have `HEIMDALL_SECRET_KEY` saved** somewhere other than the server. A database restore is useless without it.
3. **Optionally, export a configuration backup** from **Admin → Backup / restore**.
4. **Read the release notes** for the commits you are pulling (`git log --oneline <old>..<new>`), and check for new required settings.

## Upgrade order

Upgrade the **hub first, then agents**. The hub accepts older agents. Where a feature needs both sides, the hub keeps a compatibility path (for example, shared tokens keep working until you set `HEIMDALL_LEGACY_TOKENS=off`).

## Upgrade the hub

### Docker Compose

```bash
cd heimdall && git pull
cd deploy/docker
docker compose build hub agent
docker compose up -d
```

The sample `agent` service is rebuilt along with the hub.

### Kubernetes (single-node k3s with the repo script)

```bash
# from your clone of the repository
./scripts/deploy-cluster.sh
```

The script pulls `main`, builds both images tagged with the git SHA, imports them into k3s, runs `helm upgrade --reset-then-reuse-values` (so new chart defaults are applied while your values are kept), restarts and verifies. Useful variants:

| Command | Does |
| --- | --- |
| `SKIP_IMAGE_BUILD=1 ./scripts/deploy-cluster.sh` | Chart and values changes only |
| `SKIP_GIT_PULL=1 ./scripts/deploy-cluster.sh images helm restart verify` | Rebuild and apply what is already checked out |
| `./scripts/deploy-cluster.sh status` | Dump pods, services, PVCs and events |
| `FORCE_NO_CACHE=1 ./scripts/deploy-cluster.sh` | Rebuild without the layer cache |
| `OTEL_COLLECTOR=1 ./scripts/deploy-cluster.sh` | Also (re)apply the OTel collector after the Helm step |

If the script itself changed during `git pull`, it re-executes the new version. If a deploy log looks stale, run the script once more.

### Kubernetes (any cluster)

Build and push new images, then:

```bash
helm upgrade heimdall deploy/helm/heimdall -n heimdall --reset-then-reuse-values \
  --set image.hub=<registry>/heimdall-hub:<new-tag> \
  --set image.agent=<registry>/heimdall-agent:<new-tag>
```

Use `--reset-then-reuse-values` (Helm 3.14+), not `--reuse-values`. With plain `--reuse-values`, values blocks added to the chart since your install are missing, and templates fail with `nil pointer evaluating interface {}`. See the [runbook](../runbooks/helm-upgrade-new-values.md).

Tag images with something unique, such as the git SHA, rather than `:latest`. With `pullPolicy: IfNotPresent`, a node that already has `:latest` keeps running the old image.

### Standalone hub

```bash
git pull
./scripts/build-dist.sh
cd apps/hub && npm ci && npm run build
# restart your process manager (systemd, pm2, …)
```

## Upgrade agents

Agents do not update themselves. To upgrade a host installed with the one-command installer, **run the installer again**. It downloads the agent build that the hub currently serves, verifies it, and restarts the service:

```bash
curl -fsSL https://<hub>/install.sh | sudo bash
```

You need a valid enrollment token for the prompt, but the agent keeps its existing identity and secret from `/var/lib/heimdall`, so the host keeps its history.

| Install type | Upgrade by |
| --- | --- |
| One-command installer | Re-run `install.sh` |
| `scripts/install-agent.sh` | Rebuild the binary, re-run the script |
| Helm in-cluster agent | Comes with the Helm upgrade |
| Compose sample agent | Comes with `docker compose build && up -d` |

Each agent reports its version at registration. The version is the git short SHA when it is built by `build-dist.sh` or `deploy-cluster.sh`.

## After upgrading

- [ ] `curl -s <hub>/api/v1/health` returns `"status":"ok"`
- [ ] You can sign in, and MFA still works (if it does not, the secret key changed; see [troubleshooting](troubleshooting.md#mfa-or-sso-stopped-working-after-a-restart-or-restore))
- [ ] Hosts on **Fleet** are green within a minute
- [ ] **Alarms** shows no sudden flood (a new built-in rule can fire on its first evaluation)

## Rolling back

Schema changes are additive, so running an older hub against a newer database normally works.

- **Compose:** `git checkout <previous-sha>` and `docker compose up -d --build`.
- **Helm:** `helm -n heimdall rollback heimdall` (the previous image tags are in the release history).
- **Data:** if you must restore, stop the hub and run `pg_restore --clean -d heimdall <dump>`. Use the **same** `HEIMDALL_SECRET_KEY` the dump was taken with.

## Moving from Compose to Kubernetes

Follow [migrate-compose-to-k8s.md](../migrate-compose-to-k8s.md). The script `scripts/migrate-compose-to-k8s.sh` dumps the Compose database, installs the chart and restores the dump into it.

## Rotating the secret key

There is no in-place key rotation. To rotate:

1. Export a backup **with secrets** (`Admin → Backup`, or `GET /api/v1/admin/backup?includeSecrets=1`). The file contains plaintext secrets, so protect it.
2. Deploy a fresh hub with the new key.
3. Restore the backup. Secrets are re-encrypted under the new key.
4. Securely delete the backup file.
