# Runbook: first upgrade after the security-review hardening

`scripts/deploy-cluster.sh` (Helm `--reset-then-reuse-values` + `values-host-mounts.yaml`) needs no
extra flags. What changes on that first upgrade, and what to do if something looks wrong:

| Change | Effect on an existing install | If it breaks |
| --- | --- | --- |
| Session secret moves to Secret `heimdall-secrets` | Kept if you set `hub.env.HEIMDALL_SESSION_SECRET`; generated if the release had none or the old placeholder. Generated = **everyone signs in once more** | Nothing to fix. To pin one: `--set-string hub.env.HEIMDALL_SESSION_SECRET=$(openssl rand -hex 32)` or `hub.sessionSecret.existingSecret` |
| Postgres password moves to `heimdall-secrets` | Existing Deployment/PVC → keeps `heimdall` (what the volume was initialised with) | `password authentication failed`: [postgres-password.md](postgres-password.md) |
| `agent.hostMounts.enabled` defaults to `false` | `deploy-cluster.sh` passes `values-host-mounts.yaml`, which turns it on | Manual `helm upgrade`: add `-f deploy/helm/heimdall/values-host-mounts.yaml` (or `SKIP_HOST_MOUNTS` was set) |
| Hub/agent/collector securityContext (non-root, read-only root FS, no caps) | Hub writes only `/tmp` and `/app/.next/cache` (emptyDirs) | `EROFS` / `read-only file system` in hub logs: `--set hub.containerSecurityContext.readOnlyRootFilesystem=false` and report the path |
| OTLP NetworkPolicy (`otel.collector.networkPolicy.enabled`) | Only in-cluster pods reach the collector on 4317/4318 | Traces stop from a **hostNetwork** app: add `otel.collector.networkPolicy.extraFrom=[{ipBlock: {cidr: <node CIDR>}}]`, or disable the policy |
| Agent refuses plain-http hub URLs on routable hosts | In-cluster `http://heimdall-hub:43123` and Compose `http://hub:43123` are fine | Bare-metal agent logs `refusing plain-http hub URL`: add `HEIMDALL_ALLOW_INSECURE=1` to `/etc/heimdall/agent.env` (or move the hub to https), then `systemctl restart heimdall-agent` |
| Agent log tail refuses symlinked paths | `/var/log/containers`, `/var/log/pods` still followed | `refusing to follow symlink`: point `HEIMDALL_LOG_PATHS` at the real file or set `HEIMDALL_LOG_FOLLOW_SYMLINKS=1` |

Compose installs: `.env` now needs `HEIMDALL_SESSION_SECRET` and `POSTGRES_PASSWORD` (`heimdall` for
an existing volume); `docker compose up` names whichever is missing.

Verify after the deploy:

```bash
kubectl -n heimdall get secret heimdall-secrets -o jsonpath='{.data}' | grep -o '"[a-z-]*"'   # session-secret, postgres-password
kubectl -n heimdall get deploy heimdall-agent -o jsonpath='{.spec.template.spec.volumes[*].name}{"\n"}'  # includes host-root
kubectl -n heimdall rollout status deploy/heimdall-hub && kubectl -n heimdall logs deploy/heimdall-hub --tail=50
```
