# Runbook: Postgres lost or won't start (Kubernetes)

## Symptoms
- Hub pages show `ERROR <digest>`, and hub logs show `ECONNREFUSED <postgres-svc>:5432`.
- `pg_isready` inside the `heimdall-postgres` pod gets no response.
- The agent is in CrashLoopBackOff, because it cannot register without the database.

## Known causes

| Cause | Evidence | Fix |
| --- | --- | --- |
| No persistent volume (charts before the `postgres-data` PVC): a container restart wiped the database | Empty database after a pod restart | Upgrade the chart. It now creates a PVC that is kept on uninstall. Restore from a dump |
| The host's AppArmor profile for containerd (`cri-containerd.apparmor.d`) denies signals between Postgres processes. Seen after kernel upgrades on Ubuntu hosts | `journalctl -k \| grep 'apparmor="DENIED".*signal'`; Postgres logs `could not signal for checkpoint: Permission denied` | `helm upgrade … --reset-then-reuse-values --set postgres.appArmorProfile=Unconfined` |
| The stock entrypoint's `gosu` spins at 100% CPU when the container runs as root, so `initdb` never finishes | Postgres stuck at startup, high CPU | The chart runs Postgres as uid 70 (`postgres.runAsUser`), which skips `gosu` |

The chart also sets `PGDATA=/var/lib/postgresql/data/pgdata`, readiness and liveness probes, and the `Recreate` strategy.

## Recovery

Sources, in order of preference: a recent `pg_dump`, the old Compose volume `heimdall_heimdall_pg`, or a migration dump in `/var/tmp/heimdall-migrate-*/heimdall.dump`.

```bash
./scripts/pg-recover.sh dump    # copy the volume, run postgres directly (no entrypoint), write ~/heimdall-pg-recovery/*.dump
./scripts/deploy-cluster.sh     # create the PVC (the postgres pod may crash-loop until seeded)
./scripts/pg-recover.sh seed    # copy the recovered data dir into the PVC, restart postgres, hub and agent
```

Alternatively, `./scripts/pg-recover.sh restore` runs `pg_restore` into a working cluster Postgres.

The database is only useful with the **same** `HEIMDALL_SECRET_KEY` it was written with.

## Prevention
- Schedule backups: `kubectl -n heimdall exec deploy/heimdall-postgres -- pg_dump -U heimdall -Fc heimdall > heimdall-$(date +%F).dump`
- Back up Secret `heimdall-hub-secret-key` separately. It decrypts the sealed secrets in the database.
