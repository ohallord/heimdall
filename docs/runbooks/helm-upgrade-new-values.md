# Helm upgrade fails with `nil pointer evaluating interface {}.<key>`

## Symptom
`./scripts/deploy-cluster.sh` fails at the Helm step right after a phase adds a new top-level
values block, e.g. Phase 27:

```
Error: UPGRADE FAILED: template: heimdall/templates/otel-collector.yaml:1:14: ...
<.Values.otel.collector.enabled>: nil pointer evaluating interface {}.collector
```

## Cause
`helm upgrade --reuse-values` reuses only the last release's values. Defaults that are new in the
chart's `values.yaml` (here `otel:`) are skipped, so templates see `nil`.

## Fix
`deploy-cluster.sh` uses `--reset-then-reuse-values` (Helm >= 3.14). This applies chart defaults
first, then the release's values. On older Helm it passes `helm get values` through `-f`, which has
the same effect. Regression test: `scripts/test-deploy-cluster-helm.sh`.

Manual one-off on an old checkout:

```
helm upgrade heimdall deploy/helm/heimdall -n heimdall --reset-then-reuse-values \
  -f deploy/helm/heimdall/values-host-mounts.yaml --set-string image.hub=... --set-string image.agent=...
```
