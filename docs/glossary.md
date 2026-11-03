# Glossary

| Term | Meaning |
| --- | --- |
| **Active cluster** | The cluster whose Kubernetes health the Fleet page shows. Set in Admin → Clusters |
| **Agent** | `heimdall-agent`, the Go process on each host that pushes data to the hub |
| **Agent secret** (`hda_`) | Per-agent credential minted at registration and stored in `/var/lib/heimdall/agent-secret` |
| **Alarm** | An alert event in the console. Can be open, muted, recovered or dismissed |
| **Band** | Green, yellow or red status from comparing a value with warn and alarm thresholds |
| **Bootstrap token** | Hub-wide registration token (`HEIMDALL_BOOTSTRAP_TOKEN` or rotated `hdb_`). Can be disabled |
| **Cluster ID** | Label (`HEIMDALL_CLUSTER_ID`, default `default`) grouping agents and K8s data |
| **Collector** | The OpenTelemetry Collector (`otelcol-contrib`) that ships host metrics, journald or file logs, and app traces |
| **Cooldown** | 15-minute window in which the same alert identity does not fire again |
| **Enrollment token** (`hdt_`) | Token used to add new servers. Has an expiry and maximum uses |
| **Fingerprint** | Hash identifying "the same alert" (org, rule or source, agent, metric) for mute, dedupe and recovery |
| **Finding** | A security issue from Trivy, OSV, GitHub, GitLab, Falco or host posture |
| **Host posture** | Trivy scan of a host's root filesystem (OS packages and misconfigurations) |
| **Hub** | The Heimdall server: web console, API, database access, alerting |
| **Integration token** | `hdo_` (OTel), `hdu_` (UniFi), `hdr_` (runtime/Falco). One active per kind |
| **Legacy token** | An agent still authenticating with a shared token rather than its own secret |
| **Mute** | Silence one alert identity for 15, 30, 60 or 240 minutes |
| **Pause** | Global switch that stops all notifications (and new metric and log alarms) |
| **Quiet hours** | Per-user window in which non-critical notifications are held back |
| **Re-enroll** | Admin action that clears an agent's secret so it can register again |
| **Recovered** | An alarm whose condition cleared on its own |
| **Remote** | A connected GitHub organization or GitLab project for findings sync |
| **Revoke** | Admin action that immediately invalidates an agent's secret |
| **State directory** | `HEIMDALL_STATE_DIR` (default `/var/lib/heimdall`). Must persist |
| **Watch mounts** | Filesystems an agent reports disk usage for. A missing one raises an alarm |
