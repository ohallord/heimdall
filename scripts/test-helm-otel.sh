#!/usr/bin/env bash
# Assert Helm renders the OTel collector (DaemonSet / sidecar) correctly.
set -euo pipefail
cd "$(dirname "$0")/.."
C=deploy/helm/heimdall
B=(--set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN=t)
fail() { echo "FAIL: $*" >&2; exit 1; }
render() { helm template heimdall "$C" "${B[@]}" "$@"; }

# default: no collector
render | grep -q 'otelcol' && fail "collector rendered by default"

# enabled without token must fail
if render --set otel.collector.enabled=true >/dev/null 2>&1; then fail "enabled without token should fail"; fi

# daemonset mode
out=$(render --set otel.collector.enabled=true --set-string otel.collector.token=hdo_x)
grep -q 'kind: DaemonSet' <<<"$out" || fail "no DaemonSet"
grep -q 'filelog' <<<"$out" || fail "no filelog receiver"
grep -q 'opentelemetry-collector-contrib:0.111.0' <<<"$out" || fail "image not pinned"
grep -q 'http://heimdall-hub:43123' <<<"$out" || fail "default endpoint"
grep -q "traces:" <<<"$out" || fail "no traces pipeline by default"
grep -q "0.0.0.0:4318" <<<"$out" || fail "no otlp http receiver"
grep -q "internalTrafficPolicy: Local" <<<"$out" || fail "no node-local otlp Service"
grep -q "containerPort: 4317" <<<"$out" || fail "no otlp grpc port"

# traces off
out=$(render --set otel.collector.enabled=true --set-string otel.collector.token=hdo_x --set otel.collector.traces=false)
grep -q "traces:" <<<"$out" && fail "traces pipeline with traces=false"
grep -q "4318" <<<"$out" && fail "otlp port with traces=false"

# logs off
out=$(render --set otel.collector.enabled=true --set-string otel.collector.token=hdo_x --set otel.collector.logs=false)
grep -q 'filelog' <<<"$out" && fail "filelog present with logs=false"

# existing secret: no chart-made Secret
out=$(render --set otel.collector.enabled=true --set-string otel.collector.existingSecret.name=mine)
grep -q 'name: mine' <<<"$out" || fail "existingSecret not referenced"
grep -q 'hdo_' <<<"$out" && fail "token leaked"

# sidecar mode: no DaemonSet, container in agent pod
out=$(render --set otel.collector.enabled=true --set-string otel.collector.token=hdo_x --set-string otel.collector.mode=sidecar)
grep -q 'kind: DaemonSet' <<<"$out" && fail "DaemonSet in sidecar mode"
grep -q 'name: otelcol' <<<"$out" || fail "no sidecar container"
grep -q 'filelog' <<<"$out" && fail "sidecar must not tail logs"
grep -q "traces:" <<<"$out" && fail "sidecar must not receive traces"

# Beyla eBPF auto-instrumentation (off by default)
render | grep -qi 'beyla' && fail "beyla rendered by default"
if render --set otel.beyla.enabled=true >/dev/null 2>&1; then fail "beyla without collector traces should fail"; fi
out=$(render --set otel.collector.enabled=true --set-string otel.collector.token=hdo_x --set otel.beyla.enabled=true)
grep -q 'grafana/beyla:3.38.0' <<<"$out" || fail "beyla image not pinned"
grep -q 'hostPID: true' <<<"$out" || fail "beyla needs hostPID"
grep -q 'kind: ClusterRole$' <<<"$out" || fail "beyla ClusterRole"
grep -q 'http://heimdall-otelcol:4318' <<<"$out" || fail "beyla must export to node-local collector"
grep -q 'http/protobuf' <<<"$out" || fail "beyla protocol"
grep -q 'k8s_namespace' <<<"$out" || fail "beyla discovery"
grep -q 'k8s_deployment_name: "heimdall-hub"' <<<"$out" || fail "beyla must exclude the hub"
out=$(render --set otel.collector.enabled=true --set-string otel.collector.token=hdo_x --set otel.collector.traces=false --set otel.beyla.enabled=true 2>&1) && fail "beyla with traces=false should fail"
echo "ok"
