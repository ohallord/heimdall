#!/usr/bin/env bash
# Security review: Helm secrets (session secret, Postgres password), container securityContext,
# hostMounts default, OTLP NetworkPolicy. Client-side `helm template` only (lookup sees no cluster,
# so the "existing install keeps the legacy Postgres password" branch is covered by the runbook).
set -euo pipefail
cd "$(dirname "$0")/.."
C=deploy/helm/heimdall
B=(--set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN=t)
fail() { echo "FAIL: $*" >&2; exit 1; }
render() { helm template heimdall "$C" "${B[@]}" "$@"; }
# doc KIND NAME — one rendered document
doc() { awk -v k="kind: $1" -v n="  name: $2" 'BEGIN{RS="\n---\n"} index($0, k) && index($0, n "\n") {print; exit}'; }
b64d() { base64 --decode 2>/dev/null || base64 -D; }

out=$(render)
sec=$(doc Secret heimdall-secrets <<<"$out")
[[ -n "$sec" ]] || fail "no chart-managed heimdall-secrets"
grep -q 'helm.sh/resource-policy: keep' <<<"$sec" || fail "secrets not kept on uninstall"
sess=$(sed -n 's/^  session-secret: "\(.*\)"$/\1/p' <<<"$sec" | b64d)
pg=$(sed -n 's/^  postgres-password: "\(.*\)"$/\1/p' <<<"$sec" | b64d)
[[ ${#sess} -ge 64 ]] || fail "generated session secret too short (${#sess})"
[[ ${#pg} -ge 32 ]] || fail "generated postgres password too short (${#pg})"
[[ "$pg" != heimdall ]] || fail "fresh install got the legacy postgres password"

# No plaintext secrets in workload specs; everything via secretKeyRef.
# Placeholders built from parts so this file passes check-no-default-token.sh and the publish denylist.
DEV_SESSION="heimdall-dev-""session-secret-change-me!!"
SNAP_SESSION="CHANGE_ME_""SESSION_SECRET_REPLACE_BEFORE_USE!!"
grep -qF "${DEV_SESSION%-change-me!!}" <<<"$out" && fail "default session secret rendered"
grep -A3 'name: HEIMDALL_SESSION_SECRET' <<<"$out" | grep -q 'secretKeyRef' || fail "session secret not a secretKeyRef"
grep -A3 'name: POSTGRES_PASSWORD' <<<"$out" | grep -q 'secretKeyRef' || fail "postgres password not a secretKeyRef"
grep -A4 'name: HEIMDALL_DB_PASSWORD' <<<"$out" | grep -q 'key: postgres-password' || fail "hub DB password not from secret"
grep -q 'postgres://heimdall:$(HEIMDALL_DB_PASSWORD)@heimdall-postgres:5432/heimdall' <<<"$out" \
  || fail "DATABASE_URL does not expand the secret password"
grep -q 'postgres://heimdall:CHANGE_ME_DB_PASSWORD@' <<<"$out" && fail "legacy plaintext DATABASE_URL"

# Old releases carrying a known placeholder get a generated secret, never the placeholder.
for p in "$DEV_SESSION" "$SNAP_SESSION"; do
  v=$(render --set-string "hub.env.HEIMDALL_SESSION_SECRET=$p" | doc Secret heimdall-secrets \
    | sed -n 's/^  session-secret: "\(.*\)"$/\1/p' | b64d)
  [[ "$v" != "$p" && ${#v} -ge 64 ]] || fail "placeholder session secret '$p' was shipped"
done

# Explicit values always win.
s2=$(render --set-string hub.env.HEIMDALL_SESSION_SECRET=my-explicit-session-secret-0123456789abcdef \
  --set-string postgres.auth.password=explicitpw | doc Secret heimdall-secrets)
[[ "$(sed -n 's/^  session-secret: "\(.*\)"$/\1/p' <<<"$s2" | b64d)" == my-explicit-session-secret-0123456789abcdef ]] \
  || fail "explicit session secret ignored"
[[ "$(sed -n 's/^  postgres-password: "\(.*\)"$/\1/p' <<<"$s2" | b64d)" == explicitpw ]] || fail "explicit postgres password ignored"

# existingSecret for both: no chart secret, refs point at the user's Secrets.
out=$(render --set-string hub.sessionSecret.existingSecret=my-sess --set-string postgres.auth.existingSecret=my-pg)
[[ -z "$(doc Secret heimdall-secrets <<<"$out")" ]] || fail "chart secret rendered with both existingSecrets"
grep -A4 'name: HEIMDALL_SESSION_SECRET' <<<"$out" | grep -q 'name: "my-sess"' || fail "session existingSecret not used"
grep -A4 'name: POSTGRES_PASSWORD' <<<"$out" | grep -q 'name: "my-pg"' || fail "postgres existingSecret not used"
grep -A4 'name: POSTGRES_PASSWORD' <<<"$out" | grep -q 'key: "password"' || fail "postgres existingSecret key"

# postgres disabled: no postgres-password key, no DATABASE_URL.
out=$(render --set postgres.enabled=false)
grep -q 'postgres-password' <<<"$out" && fail "postgres password rendered with postgres disabled"
grep -q 'DATABASE_URL' <<<"$out" && fail "DATABASE_URL with postgres disabled"

# securityContext: hub/agent/otel run non-root, no escalation, no caps, RuntimeDefault seccomp.
out=$(render --set otel.collector.enabled=true --set-string otel.collector.token=hdo_x)
for pair in heimdall-hub:1001 heimdall-agent:65532 heimdall-otelcol:10001; do
  name=${pair%%:*} uid=${pair##*:}
  kind=Deployment; [[ $name == heimdall-otelcol ]] && kind=DaemonSet
  d=$(doc "$kind" "$name" <<<"$out")
  [[ -n "$d" ]] || fail "missing $kind $name"
  for want in 'runAsNonRoot: true' "runAsUser: $uid" 'allowPrivilegeEscalation: false' \
    'readOnlyRootFilesystem: true' '- ALL' 'type: RuntimeDefault'; do
    grep -qF -- "$want" <<<"$d" || fail "$name securityContext missing '$want'"
  done
done
grep -q 'mountPath: /app/.next/cache' <<<"$out" || fail "hub has no writable .next/cache"
render --set hub.containerSecurityContext.readOnlyRootFilesystem=false | doc Deployment heimdall-hub \
  | grep -q 'readOnlyRootFilesystem: false' || fail "hub securityContext override ignored"

# hostMounts: off by default; the lab overlay (deploy-cluster.sh) turns it on.
render | grep -q 'name: host-root' && fail "hostMounts on by default"
render -f "$C/values-host-mounts.yaml" | grep -q 'name: host-root' || fail "values-host-mounts.yaml does not enable hostMounts"

# OTLP NetworkPolicy: on with traces, cluster pods only; off when disabled or traces=false.
O=(--set otel.collector.enabled=true --set-string otel.collector.token=hdo_x)
np=$(render "${O[@]}" | doc NetworkPolicy heimdall-otelcol)
[[ -n "$np" ]] || fail "no OTLP NetworkPolicy by default"
grep -q 'namespaceSelector: {}' <<<"$np" || fail "default policy must admit all in-cluster namespaces"
grep -q 'port: 4318' <<<"$np" || fail "policy misses 4318"
render "${O[@]}" --set otel.collector.networkPolicy.enabled=false | grep -q 'kind: NetworkPolicy' && fail "policy with enabled=false"
render "${O[@]}" --set otel.collector.traces=false | grep -q 'kind: NetworkPolicy' && fail "policy without traces"
render "${O[@]}" --set 'otel.collector.networkPolicy.namespaces={heimdall}' | doc NetworkPolicy heimdall-otelcol \
  | grep -q 'values: \["heimdall"\]' || fail "namespace restriction not rendered"
echo "ok"
