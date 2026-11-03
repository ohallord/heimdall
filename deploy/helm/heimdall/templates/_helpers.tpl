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
/host,/host/var
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

{{/* OTel collector helpers. */}}
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
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
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
