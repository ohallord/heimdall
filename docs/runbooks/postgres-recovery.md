# Runbook: Postgres lost / won't start (k8s)

## Symptoms
- Hub pages show `ERROR <digest>`; hub logs: `ECONNREFUSED <postgres-svc>:5432`.
- `heimdall-postgres` pod is Ready (the old chart had no probes) but `pg_isready` says no response.
- Agent CrashLoopBackOff (cannot register without the DB).

## Incident 2026-10-30 (what happened)
1. Chart `postgres.yaml` had **no volume**: a container restart wiped the DB.
2. After the node moved to kernel `7.0.0-42` (installed Oct 29), the default containerd AppArmor
   profile (`cri-containerd.apparmor.d`) denied `signal send` between postgres processes
   (peer label `cri-containerd.apparmor.d//&unconfined`). Evidence:
   `journalctl -k | grep 'apparmor="DENIED".*signal'`; postgres logs `could not signal for checkpoint: Permission denied`.
3. Separately, `gosu` (used by the stock postgres entrypoint when run as root) spun at 100% CPU, so a fresh
   `initdb` through the entrypoint never completed.

## Fixes now in the chart
- `postgres-data` PVC (kept on uninstall), `PGDATA=/var/lib/postgresql/data/pgdata`, probes, `Recreate`.
- Runs as uid 70 (`postgres.runAsUser`) so the entrypoint skips gosu.
- `postgres.appArmorProfile=Unconfined` on affected hosts (persisted via `helm upgrade --reuse-values --set postgres.appArmorProfile=Unconfined`).

## Recovery (used)
Source: the old Compose volume `heimdall_heimdall_pg` (or `/var/tmp/heimdall-migrate-*/heimdall.dump`).
```
./scripts/pg-recover.sh dump    # copies the volume, runs postgres directly (no entrypoint), writes ~/heimdall-pg-recovery/*.dump
./scripts/deploy-cluster.sh     # creates the PVC (postgres pod may crash-loop until seeded)
./scripts/pg-recover.sh seed    # copies the recovered data dir into the PVC, restarts postgres/hub/agent
```
Fallback `./scripts/pg-recover.sh restore` does `pg_restore` into a working cluster Postgres.

## Prevention
- Back up: `kubectl -n heimdall exec deploy/heimdall-postgres -- pg_dump -U heimdall -Fc heimdall > heimdall-$(date +%F).dump`.
- Also back up Secret `heimdall-hub-secret-key` (decrypts sealed secrets in the DB).
