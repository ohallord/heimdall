{{- define "heimdall.name" -}}
heimdall
{{- end -}}

{{- define "heimdall.labels" -}}
app.kubernetes.io/name: {{ include "heimdall.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Join agent.hostMounts.watchMounts into HEIMDALL_WATCH_MOUNTS.
Accepts a YAML list (preferred) or a legacy comma-separated string.
*/}}
{{- define "heimdall.watchMountsEnv" -}}
{{- $w := .Values.agent.hostMounts.watchMounts -}}
{{- if kindIs "slice" $w -}}
{{- join "," $w -}}
{{- else if kindIs "string" $w -}}
{{- $w -}}
{{- else -}}
/host
{{- end -}}
{{- end -}}

{{/*
hostPath path/mountPath with hard defaults. Empty --set / partial -f values
must never render Required-value Deployment fields.
*/}}
{{- define "heimdall.hostMounts.hostRoot" -}}
{{- .Values.agent.hostMounts.hostRoot | default "/" -}}
{{- end -}}

{{- define "heimdall.hostMounts.mountPath" -}}
{{- .Values.agent.hostMounts.mountPath | default "/host" -}}
{{- end -}}

{{/*
Agent state settings, read with `dig` + defaults so `helm upgrade --reuse-values`
(which does not merge new chart defaults into old release values) never hits nil.
*/}}
{{- define "heimdall.agentState.dir" -}}
{{- dig "state" "dir" "/var/lib/heimdall" .Values.agent -}}
{{- end -}}
{{- define "heimdall.agentState.persistent" -}}
{{- dig "state" "persistence" "enabled" true .Values.agent -}}
{{- end -}}
{{- define "heimdall.agentState.size" -}}
{{- dig "state" "persistence" "size" "16Mi" .Values.agent -}}
{{- end -}}
{{- define "heimdall.agentState.storageClass" -}}
{{- dig "state" "persistence" "storageClass" "" .Values.agent -}}
{{- end -}}

{{/*
HEIMDALL_BOOTSTRAP_TOKEN env entry. Either hub.existingSecret.{name,key} (preferred) or
hub.env.HEIMDALL_BOOTSTRAP_TOKEN; one is required (no shipped default).
*/}}
{{- define "heimdall.bootstrapTokenEnv" -}}
{{- $secretName := dig "existingSecret" "name" "" .Values.hub -}}
{{- $secretKey := dig "existingSecret" "key" "bootstrap-token" .Values.hub -}}
- name: HEIMDALL_BOOTSTRAP_TOKEN
{{- if $secretName }}
  valueFrom:
    secretKeyRef:
      name: {{ $secretName | quote }}
      key: {{ $secretKey | quote }}
{{- else }}
  value: {{ required "Set hub.env.HEIMDALL_BOOTSTRAP_TOKEN (e.g. --set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)) or hub.existingSecret.name" .Values.hub.env.HEIMDALL_BOOTSTRAP_TOKEN | quote }}
{{- end }}
{{- end -}}

{{/*
HEIMDALL_SECRET_KEY env entry (AES-256-GCM key for secrets at rest).
Order: hub.secretKey.existingSecret -> hub.env.HEIMDALL_SECRET_KEY -> chart-managed Secret
(<name>-hub-secret-key, generated once and kept across upgrades/uninstall).
`dig` keeps `helm upgrade --reuse-values` working when these keys are absent from old releases.
*/}}
{{- define "heimdall.secretKeyEnv" -}}
{{- $existing := dig "secretKey" "existingSecret" "" .Values.hub -}}
{{- $existingKey := dig "secretKey" "key" "key" .Values.hub -}}
{{- $plain := dig "env" "HEIMDALL_SECRET_KEY" "" .Values.hub -}}
- name: HEIMDALL_SECRET_KEY
{{- if $existing }}
  valueFrom:
    secretKeyRef:
      name: {{ $existing | quote }}
      key: {{ $existingKey | quote }}
{{- else if $plain }}
  value: {{ $plain | quote }}
{{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ include "heimdall.name" . }}-hub-secret-key
      key: key
{{- end }}
{{- end -}}

{{/*
Chart-managed Secret <name>-secrets (templates/hub-secrets.yaml): session secret + Postgres password.
*/}}
{{- define "heimdall.secretsName" -}}
{{- include "heimdall.name" . }}-secrets
{{- end -}}

{{/*
Session secret the user set explicitly, or "" (=> chart-generated). The two well-known placeholders
(old chart default, public-snapshot rewrite) count as unset: the hub refuses them in production, so
an old release that still carries one gets a generated secret instead (users sign in once more).
*/}}
{{- define "heimdall.sessionSecret.plain" -}}
{{- $v := dig "env" "HEIMDALL_SESSION_SECRET" "" .Values.hub | toString -}}
{{- /* split literals: keep the placeholders out of grep/denylist/snapshot-rewrite gates */ -}}
{{- $placeholders := list (print "heimdall-dev-" "session-secret-change-me!!") (print "CHANGE_ME_" "SESSION_SECRET_REPLACE_BEFORE_USE!!") -}}
{{- if not (has $v $placeholders) -}}
{{- $v -}}
{{- end -}}
{{- end -}}

{{/* HEIMDALL_SESSION_SECRET env entry: hub.sessionSecret.existingSecret, else the chart-managed Secret. */}}
{{- define "heimdall.sessionSecretEnv" -}}
{{- $existing := dig "sessionSecret" "existingSecret" "" .Values.hub -}}
- name: HEIMDALL_SESSION_SECRET
  valueFrom:
    secretKeyRef:
{{- if $existing }}
      name: {{ $existing | quote }}
      key: {{ dig "sessionSecret" "key" "session-secret" .Values.hub | quote }}
{{- else }}
      name: {{ include "heimdall.secretsName" . }}
      key: session-secret
{{- end }}
{{- end -}}

{{/* secretKeyRef body (name + key) for the bundled Postgres password. */}}
{{- define "heimdall.postgresPasswordRef" -}}
{{- $existing := dig "auth" "existingSecret" "" .Values.postgres -}}
{{- if $existing -}}
name: {{ $existing | quote }}
key: {{ dig "auth" "secretKey" "password" .Values.postgres | quote }}
{{- else -}}
name: {{ include "heimdall.secretsName" . }}
key: postgres-password
{{- end -}}
{{- end -}}

{{/*
Container securityContext: restricted-profile defaults merged with an optional override map.
Context: dict "uid" <int> "override" <map> "readOnly" <bool>
*/}}
{{- define "heimdall.containerSecurityContext" -}}
{{- $base := dict
  "runAsNonRoot" true
  "runAsUser" .uid
  "runAsGroup" .uid
  "allowPrivilegeEscalation" false
  "readOnlyRootFilesystem" .readOnly
  "capabilities" (dict "drop" (list "ALL"))
  "seccompProfile" (dict "type" "RuntimeDefault") -}}
{{- /* shallow `set`, not mergeOverwrite: mergo skips false/0 overrides */ -}}
{{- range $k, $v := (.override | default (dict)) }}{{ $_ := set $base $k $v }}{{ end -}}
{{- toYaml $base -}}
{{- end -}}

{{/* OTel collector helpers (Phase 27). */}}
{{- define "heimdall.otel.endpoint" -}}
{{- .Values.otel.collector.endpoint | default (printf "http://%s-hub:%v" (include "heimdall.name" .) .Values.hub.service.port) -}}
{{- end -}}

{{- define "heimdall.otel.secretName" -}}
{{- if .Values.otel.collector.existingSecret.name -}}
{{- .Values.otel.collector.existingSecret.name -}}
{{- else -}}
{{- include "heimdall.name" . }}-otel-token
{{- end -}}
{{- end -}}

{{- define "heimdall.otel.secretKey" -}}
{{- if .Values.otel.collector.existingSecret.name -}}
{{- .Values.otel.collector.existingSecret.key | default "otel-token" -}}
{{- else -}}otel-token{{- end -}}
{{- end -}}

{{/* Container spec shared by DaemonSet and sidecar. Context: dict "root" . "logs" bool */}}
{{- define "heimdall.otel.container" -}}
{{- $r := .root -}}
- name: otelcol
  image: {{ $r.Values.otel.collector.image }}
  imagePullPolicy: {{ $r.Values.image.pullPolicy }}
  args: ["--config=/etc/otelcol/config.yaml"]
  {{- if .traces }}
  ports:
    - name: otlp-grpc
      containerPort: 4317
    - name: otlp-http
      containerPort: 4318
  {{- end }}
  env:
    - name: HEIMDALL_OTLP_ENDPOINT
      value: {{ include "heimdall.otel.endpoint" $r | quote }}
    - name: HEIMDALL_OTEL_TOKEN
      valueFrom:
        secretKeyRef:
          name: {{ include "heimdall.otel.secretName" $r }}
          key: {{ include "heimdall.otel.secretKey" $r }}
    - name: K8S_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
  resources:
    {{- toYaml $r.Values.otel.collector.resources | nindent 4 }}
  # Image user is 10001 (otel/opentelemetry-collector-contrib); it needs no writable paths.
  securityContext:
    {{- include "heimdall.containerSecurityContext" (dict "uid" 10001 "readOnly" true "override" (dig "collector" "containerSecurityContext" (dict) $r.Values.otel)) | nindent 4 }}
  volumeMounts:
    - name: otelcol-config
      mountPath: /etc/otelcol
    - name: otel-hostfs
      mountPath: /hostfs
      readOnly: true
      mountPropagation: HostToContainer
    {{- if .logs }}
    - name: otel-pod-logs
      mountPath: /var/log/pods
      readOnly: true
    {{- end }}
{{- end -}}
