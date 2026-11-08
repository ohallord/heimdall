#!/usr/bin/env bash
# Recover Heimdall Postgres after the k8s pod lost its (volume-less) data dir.
#   ./scripts/pg-recover.sh dump      # read-only: dump the old Compose volume via a throwaway container
#   ./scripts/pg-recover.sh seed      # copy the recovered data dir into the cluster postgres PVC (preferred)
#   ./scripts/pg-recover.sh restore   # alt: pg_restore a dump into a working cluster Postgres
# Logs: tmp/runner/pg-recover/. Never touches the original docker volume (works on a copy).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$HOME/heimdall-pg-recovery}"
VOL="${VOL:-heimdall_heimdall_pg}"
NS="${K8S_NAMESPACE:-heimdall}"
# Dumps hold every secret in the DB: private dirs (umask 077), no predictable shared /tmp paths.
umask 077
LOGDIR="tmp/runner/pg-recover"; mkdir -p "$LOGDIR" "$OUT"; chmod 700 "$OUT"
exec > >(tee -a "$LOGDIR/${1:-none}.log") 2>&1
log() { printf '==> %s\n' "$*"; }

case "${1:-}" in
dump)
  docker volume inspect "$VOL" >/dev/null
  log "copy volume $VOL -> heimdall_pg_recover (original untouched)"
  docker volume rm -f heimdall_pg_recover >/dev/null 2>&1 || true
  docker volume create heimdall_pg_recover >/dev/null
  docker run --rm -v "$VOL":/from:ro -v heimdall_pg_recover:/to alpine sh -c 'cp -a /from/. /to/'
  docker rm -f pg-recover >/dev/null 2>&1 || true
  log "start throwaway postgres directly (docker-entrypoint/gosu hangs on this host)"
  docker run -d --name pg-recover --user 70 --entrypoint postgres \
    -v heimdall_pg_recover:/var/lib/postgresql/data postgres:16-alpine -D /var/lib/postgresql/data >/dev/null
  for i in $(seq 1 60); do docker exec pg-recover pg_isready -U heimdall -d heimdall >/dev/null 2>&1 && break; sleep 1; done
  docker exec pg-recover pg_isready -U heimdall -d heimdall || { docker logs pg-recover 2>&1 | tail -20; exit 1; }
  RDIR="$(docker exec pg-recover mktemp -d | tr -d '\r\n')"
  [[ "$RDIR" == /tmp/* ]] || { echo "unexpected temp dir in pg-recover: $RDIR"; exit 1; }
  docker exec pg-recover pg_dump -U heimdall -d heimdall --format=custom --file="$RDIR/heimdall.dump"
  docker cp "pg-recover:$RDIR/heimdall.dump" "$OUT/heimdall-from-volume.dump"
  chmod 600 "$OUT/heimdall-from-volume.dump"
  log "freshness check"
  docker exec pg-recover psql -U heimdall -d heimdall -Atc \
    "select 'agents', count(*), max(last_seen_at) from agents union all select 'users', count(*), max(created_at) from users" || true
  # Clean shutdown so the copied data dir needs no crash recovery when seeded.
  docker stop -t 30 pg-recover >/dev/null; docker rm pg-recover >/dev/null
  ls -l "$OUT"
  log "dump done: $OUT/heimdall-from-volume.dump"
  ;;
seed)
  # Copy the recovered data dir (docker volume heimdall_pg_recover) into the postgres PVC via a one-off
  # root pod with hostPath. Needed where the postgres entrypoint cannot initdb a fresh DB (gosu/pg_ctl broken).
  SRC="${SRC:-/var/lib/docker/volumes/heimdall_pg_recover/_data}"
  docker run --rm -v heimdall_pg_recover:/d alpine test -f /d/PG_VERSION || { echo "no recovered volume heimdall_pg_recover (run dump first)"; exit 1; }
  kubectl -n "$NS" get pvc heimdall-postgres-data >/dev/null || { echo "no PVC: deploy chart first"; exit 1; }
  log "stop hub, agent, postgres"
  kubectl -n "$NS" scale deploy/heimdall-hub deploy/heimdall-agent deploy/heimdall-postgres --replicas=0
  sleep 5
  kubectl -n "$NS" delete pod pg-seed --ignore-not-found
  kubectl -n "$NS" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata: { name: pg-seed }
spec:
  restartPolicy: Never
  containers:
    - name: seed
      image: postgres:16-alpine
      command: ["sh","-c","rm -rf /dst/pgdata && mkdir -p /dst/pgdata && cp -a /src/. /dst/pgdata/ && chown -R 70:70 /dst && chmod 700 /dst/pgdata && ls /dst/pgdata/PG_VERSION && echo SEED_OK"]
      securityContext: { runAsUser: 0 }
      volumeMounts: [{ name: src, mountPath: /src, readOnly: true }, { name: dst, mountPath: /dst }]
  volumes:
    - name: src
      hostPath: { path: $SRC, type: Directory }
    - name: dst
      persistentVolumeClaim: { claimName: heimdall-postgres-data }
YAML
  ph=""
  for i in $(seq 1 90); do
    ph="$(kubectl -n "$NS" get pod pg-seed -o jsonpath='{.status.phase}')"
    [[ "$ph" == Succeeded || "$ph" == Failed ]] && break; sleep 2
  done
  kubectl -n "$NS" logs pg-seed | tail -5
  [[ "$ph" == Succeeded ]] || { echo "seed pod phase: $ph"; exit 1; }
  kubectl -n "$NS" delete pod pg-seed
  kubectl -n "$NS" scale deploy/heimdall-postgres --replicas=1
  kubectl -n "$NS" rollout status deploy/heimdall-postgres --timeout=180s
  POD="$(kubectl -n "$NS" get pods -l app.kubernetes.io/component=postgres -o jsonpath='{.items[0].metadata.name}')"
  kubectl -n "$NS" exec "$POD" -- psql -U heimdall -d heimdall -Atc \
    "select 'users', count(*) from users union all select 'agents', count(*) from agents"
  kubectl -n "$NS" scale deploy/heimdall-hub deploy/heimdall-agent --replicas=1
  kubectl -n "$NS" rollout status deploy/heimdall-hub --timeout=180s
  log "seed done"
  ;;
restore)
  DUMP="${DUMP:-$OUT/heimdall-from-volume.dump}"
  [[ -f "$DUMP" ]] || { echo "missing $DUMP (run dump first, or DUMP=path)"; exit 1; }
  kubectl -n "$NS" get pvc heimdall-postgres-data >/dev/null || { echo "no postgres PVC: deploy the chart fix first"; exit 1; }
  kubectl -n "$NS" rollout status deploy/heimdall-postgres --timeout=180s
  POD="$(kubectl -n "$NS" get pods -l app.kubernetes.io/component=postgres -o jsonpath='{.items[0].metadata.name}')"
  log "pg pod $POD; hub off during restore"
  kubectl -n "$NS" scale deploy/heimdall-hub --replicas=0
  RDIR="$(kubectl -n "$NS" exec "$POD" -- mktemp -d | tr -d '\r\n')"
  [[ "$RDIR" == /tmp/* ]] || { echo "unexpected temp dir in $POD: $RDIR"; exit 1; }
  trap 'kubectl -n "$NS" exec "$POD" -- rm -rf "$RDIR" >/dev/null 2>&1 || true' EXIT
  kubectl -n "$NS" cp "$DUMP" "$POD:$RDIR/heimdall.dump"
  kubectl -n "$NS" exec "$POD" -- pg_restore -U heimdall -d heimdall --clean --if-exists --no-owner "$RDIR/heimdall.dump" || true
  kubectl -n "$NS" exec "$POD" -- psql -U heimdall -d heimdall -Atc "select count(*) from users"
  kubectl -n "$NS" scale deploy/heimdall-hub --replicas=1
  kubectl -n "$NS" rollout status deploy/heimdall-hub --timeout=180s
  kubectl -n "$NS" rollout restart deploy/heimdall-agent
  log "restore done"
  ;;
*) echo "usage: $0 dump|seed|restore"; exit 2 ;;
esac
