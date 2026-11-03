# Alerting design

Source: `apps/hub/src/lib/alerts/`, evaluation in `src/lib/metrics/ingest.ts` and `src/lib/logs/ingest.ts`.

## Goals

- **Few, correct notifications.** Notify only when a human should act: red band, abnormal exits, real threats.
- **One identity per problem.** Mute, dedupe and recovery all key off the same fingerprint.
- **Ingest never waits on delivery.** SMTP or webhook slowness must not slow agents.
- **Self-healing console.** Alarms that clear on their own are marked recovered without anyone clicking.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Rule** | `alert_rules` row: metric, operator (`gt` `gte` `lt` `lte` `eq`), alarm threshold, optional warn threshold, enabled |
| **Threshold sample** | `(metric, value)` derived from an ingest. Some metrics carry a suffix per instance: `disk_percent:/var`, `mount_missing:/boot`, `container_exited:web` |
| **Band** | For rules with a warn threshold: `green` < warn ≤ `yellow` < alarm ≤ `red` |
| **Alert event** | `alert_events` row (an "alarm" in the UI) with `status` `open`, `resolved`, `dismissed`, plus `muted_until` |
| **Fingerprint** | `sha256(org | rule-or-source | agent-or-alarm | metric-or-name)` |

## Built-in rules

These are created per org on first ingest (`ensureHostMetricRules`):

| Rule | Metric | Default |
| --- | --- | --- |
| High CPU | `cpu_percent` | warn 85, alarm 95 |
| High memory | `mem_percent` | warn 90, alarm 98 |
| High disk | `disk_percent` (matches every `disk_percent:<mount>`) | warn 90, alarm 98 |
| Mount missing | `mount_missing` (matches each `mount_missing:<path>`) | ≥ 1 |
| Container exited | `container_exited` (matches each `container_exited:<name>`) | ≥ 1 |
| Container OOM | `container_oom` | ≥ 1 |
| Container restart loop | `container_restart_loop` | ≥ 1 |
| Container memory vs limit | `container_mem_limit_pct` | ≥ 90 |
| K8s API unreachable | `k8s_apiserver_unreachable` | ≥ 1 |
| K8s node not Ready | `k8s_node_not_ready` | ≥ 1 |
| K8s pod Pending | `k8s_pod_pending` | ≥ 1 |
| K8s pod CrashLoop | `k8s_pod_crashloop` | ≥ 1 |
| K8s deployment unhealthy | `k8s_deployment_unhealthy` | ≥ 1 |

The host band defaults follow Netdata's conventions. Operators can change thresholds or disable rules. The rule set itself is fixed: there are no user-defined rules yet.

Other alarm sources do not use `alert_rules` thresholds but share the event table and dispatch path:

- **Log rules** (`lib/logs/rules.ts`): a matching line with `alert !== false`.
- **UniFi**: critical severity events.
- **Security findings**: new critical findings when `criticalFindingsToAlarms` is on.

## Evaluation pipeline (per metrics ingest)

```
samples = derive(host, containers, k8s)

# 1. Recovery
for each (sample, enabled matching rule):
    fingerprint → breaching   if band ∈ {yellow, red} or binary rule true
                → healthy     otherwise
resolve open events whose fingerprint ∈ healthy and ∉ breaching   (status=resolved, resolved_at)
queue "Recovered" for resolved events that had notified (not yellow, not muted), one per fingerprint

# 2. New breaches (skipped entirely while paused)
for each (sample, rule) breaching:
    cooldown key = org:rule:agent:metric:{warn|alarm}; skip if fired < 15 min ago
    skip if fingerprint muted (muted_until > now)
    insert alert_event (severity critical for red band, warning otherwise)
    if alarm (red or binary): enqueueAlert(...)        # yellow = history only
```

Design notes:

- **Suffixed metrics give one alarm per instance.** A host with two full disks gets two alarms, and each recovers on its own. The rule still matches by prefix, so one "High disk" rule covers all mounts.
- **Container exits** are decided by the hub, never trusted from the agent (`markContainerExitAlerts`). A stopped container is flagged only if the exit was abnormal (non-zero code, or state `dead`) **and** it happened while monitored: it was running in the previous snapshot, it finished after that snapshot, or it was already flagged. Containers that were stopped before monitoring began, or that exited 0, do not alarm. `container_exited` recovers when the container runs again or is removed.
- **Cooldown** is held in memory per process. It limits both notifications and new event rows for the same identity to one per 15 minutes. It resets when the hub restarts.
- **Warn band** events are recorded so history and the console show trends, but they never notify, and recovering from yellow never sends a recovery notice.

## Delivery

`enqueueAlert` calls `dispatchAlert` without awaiting it. Dispatch steps:

1. **Global pause** (`HEIMDALL_ALERTS_PAUSED` or the runtime toggle) → drop.
2. **Quiet hours**: if severity is not `critical` and **every** user with quiet hours enabled is inside their window (evaluated in each user's IANA timezone; windows may wrap midnight; start = end means all day) → drop. Users without quiet hours never block delivery.
3. For each enabled channel (`smtp`, `slack`, `discord`, `sms`):
   - skip it if user preferences exist and **no** user wants that channel;
   - for SMS with no org-level `to`, use the first opted-in user's phone;
   - send. Webhook and SMS calls go through `safeFetch` (SSRF guard, 10 s timeout).
4. Errors are logged. **There is no retry and no persistent queue.**

Payloads carry `subject`, a readable `message`, labelled `fields` (host, metric, observed value, threshold, started time), and a `deepLink` to `/dashboard/alerts`. The link base comes from `HEIMDALL_PUBLIC_BASE_URL` or `HEIMDALL_PUBLIC_URL`. Recovery payloads add recovered time and duration, with severity `info`.

## Operator controls

| Control | Scope | Persistence |
| --- | --- | --- |
| Mute (15, 30, 60, 240 min) | One fingerprint | `alert_events.muted_until` |
| Dismiss / bulk dismiss | Event(s) | `status=dismissed`, `dismissed_by` |
| Rule enable / thresholds | Org | `alert_rules` |
| Quiet hours, channel opt-in | User | `user_notification_prefs` |
| Pause | Hub process | Memory (initialized from env) |

## Retention

Closed events (anything not `open`) are purged after the org's logs retention (default 60 days). Open alarms are never purged.

## Known limitations and future work

- Cooldown, pause and dedupe are per process. Running several replicas multiplies notifications. Moving them to Postgres would fix this.
- No escalation, acknowledgement or on-call routing. PagerDuty-style flows are out of scope today.
- No delivery retry. A failed webhook is only logged.
- No custom rules (metric or log). Rules are a fixed, tunable set.
- While paused, breaches are not recorded, so the alarm history has a gap for the pause window.
