# Runbook: Postgres password (bundled Postgres, Compose and Helm)

Postgres sets the password **only when it initialises an empty data volume**. Changing
`POSTGRES_PASSWORD` (Compose) or `postgres.auth.password` (Helm) later does not change the password
of an existing database; it only changes what the hub sends, and the hub then fails with
`password authentication failed for user "heimdall"`.

## What you get after the security-review upgrade

| Install | Password used |
| --- | --- |
| Helm, new install | Random 32 chars, generated once into Secret `heimdall-secrets` (key `postgres-password`) and reused on every upgrade |
| Helm, existing install (has Deployment `heimdall-postgres` or PVC `heimdall-postgres-data`), no explicit password | `heimdall` (the old chart default its volume was initialised with), stored in `heimdall-secrets` |
| Helm, `postgres.auth.password` or `postgres.auth.existingSecret` set | That value. Always wins |
| Compose | `POSTGRES_PASSWORD` from `.env`, required. Existing volumes: set `POSTGRES_PASSWORD=heimdall` |

Check what Helm stored:

```bash
kubectl -n heimdall get secret heimdall-secrets -o jsonpath='{.data.postgres-password}' | base64 -d; echo
```

## Rotate (Helm)

1. Pick a URL-safe password (it is substituted into `DATABASE_URL`): `NEW=$(openssl rand -hex 24)`.
2. Change it inside the database first:
   ```bash
   POD=$(kubectl -n heimdall get pods -l app.kubernetes.io/component=postgres -o jsonpath='{.items[0].metadata.name}')
   kubectl -n heimdall exec -i "$POD" -- psql -U heimdall -d heimdall -v ON_ERROR_STOP=1 \
     -c "ALTER USER heimdall WITH PASSWORD '$NEW';"
   ```
   (`psql` in the pod connects over the local socket, which needs no password.)
3. Store it where the chart reads it, then restart the hub:
   ```bash
   kubectl -n heimdall patch secret heimdall-secrets --type merge \
     -p "{\"data\":{\"postgres-password\":\"$(printf %s "$NEW" | base64 | tr -d '\n')\"}}"
   kubectl -n heimdall rollout restart deploy/heimdall-hub
   ```
   The chart reuses the value already in `heimdall-secrets` on later upgrades. If you set
   `postgres.auth.password` or `postgres.auth.existingSecret` instead, update that and run
   `scripts/deploy-cluster.sh helm restart`.
4. Verify: `kubectl -n heimdall logs deploy/heimdall-hub | grep -i 'password authentication'` is empty
   and the UI loads.

## Rotate (Compose)

```bash
cd deploy/docker
NEW=$(openssl rand -hex 24)
docker compose exec -T postgres psql -U heimdall -d heimdall -v ON_ERROR_STOP=1 \
  -c "ALTER USER heimdall WITH PASSWORD '$NEW';"
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$NEW/" .env
docker compose up -d hub postgres
```

## Hub cannot connect after an upgrade

`password authentication failed` right after an upgrade means the stored password and the
volume disagree (for example the Secret was deleted and re-generated, or a PVC was restored into a
fresh release). Either set the Secret back to what the volume was initialised with (`heimdall` for
pre-upgrade installs) with step 3 above, or reset the DB password to the Secret's value with step 2.

The Postgres port is never published outside the cluster; on Compose it binds `127.0.0.1:54329` only.
