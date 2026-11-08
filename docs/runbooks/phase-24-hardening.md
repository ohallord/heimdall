# Runbook — Phase 24 hardening (symptoms and fixes)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Agent log: `register failed … status 409 hostname_in_use` | The host already has an agent identity and this agent has no (or a stale) secret — usually the state dir was lost or is not persistent | Hub UI → Agents → **Re-enroll** that host, then restart the agent. Make sure `HEIMDALL_STATE_DIR` (default `/var/lib/heimdall`) is a persistent volume (Helm PVC `agent.state.*`, Compose named volume) |
| Agent log: `persist agent secret … permission denied` | State dir not writable by the agent user | Mount a writable volume; Helm sets `fsGroup: 65532` for the distroless user |
| Agent log: `status 403 agent_revoked` | An admin revoked the agent | UI → **Re-enroll**, restart agent |
| Agents show `legacy token` | Still using the shared token (grace period) | Restart/upgrade the agent so it registers and stores a secret; then optionally `HEIMDALL_LEGACY_TOKENS=off` on the hub |
| Hub returns 500 `HEIMDALL_SECRET_KEY is required` | Postgres or `NODE_ENV=production` without a key | Compose: set it in `deploy/docker/.env`. Helm: the chart creates `<release>-hub-secret-key`; if you render with `helm template`, use `hub.secretKey.existingSecret`. Generate: `openssl rand -hex 32` |
| Log: `secret decrypt failed … re-enter it`; TOTP/OIDC/alert secret reads as empty | Key changed or lost, or value tampered | Restore the original key (Helm: `kubectl -n heimdall get secret heimdall-hub-secret-key -o jsonpath='{.data.key}' \| base64 -d`). Otherwise re-enter the secrets; admins with lost TOTP sign in with a recovery code |
| `429 rate_limited` on login or MFA | Too many failed attempts for that ip+email / user | Wait for `Retry-After`; tune `HEIMDALL_RATE_LOGIN` / `HEIMDALL_RATE_MFA`. Everyone shares one IP bucket behind a proxy unless `HEIMDALL_TRUST_PROXY` is set |
| Saving an IdP / webhook / GitLab URL: `blocked_host` | Target resolves to a private, loopback or link-local address | Allowlist the narrowest host/IP/CIDR: `HEIMDALL_ALLOW_PRIVATE_HOSTS` (Helm: `--set-string hub.extraEnv.HEIMDALL_ALLOW_PRIVATE_HOSTS=…`) |
| Browser action returns `403 csrf` | Cross-origin request, or `HEIMDALL_PUBLIC_URL` does not match the URL users browse | Set `HEIMDALL_PUBLIC_URL` to the public origin |
| `helm upgrade`/`install` fails: `Set hub.env.HEIMDALL_BOOTSTRAP_TOKEN …` | Fresh install without a token (no default shipped) | `--set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)` or `hub.existingSecret.name`. `--reuse-values` upgrades keep the existing one |

Upgrade order: back up `HEIMDALL_SECRET_KEY` after the first start, then roll hub and agents together. Existing agents upgrade themselves on restart.
