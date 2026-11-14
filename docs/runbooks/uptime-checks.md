# Uptime checks

Synthetic http / tcp / tls checks run by the hub (Dashboard → **Uptime**, API `/api/v1/uptime`).

## How it runs

- A scheduler in the hub process (started from `instrumentation.ts`) wakes every 15 s and runs every enabled check
  whose `last_run_at + interval_seconds` has passed. Each run is claimed with a compare-and-swap on `last_run_at`,
  so a tick runs once even across restarts or a second replica. Up to 8 probes run at a time.
- Log lines are prefixed `[uptime]`: `scheduler started`, `DOWN <kind> <target>: <error>`, `UP … (recovered)`.
- **Turn it off:** `HEIMDALL_DISABLE_UPTIME_JOB=1`. Checks stop running; nothing is deleted.

## What counts as down

| Type | Probe |
| --- | --- |
| http | `GET` with a timeout. Up on the expected status, or any 2xx/3xx when none is set. Redirects are followed by the guarded client. |
| tcp | Opens a socket to the validated IP and closes it. |
| tls | Full verification handshake (SNI = host). Down on any verification error, expired certificate, or fewer than `tlsWarnDays` days left. |

A failing probe becomes an alarm when it has been failing for the org **sustain window** (Settings → Alert sustain
window, default 120 s, `0` = first failure) **and** at least two probes in a row failed (a single dropped packet
never pages). The alarm is a critical `alert_events` row with `rule_id` NULL, `payload.source = "uptime"` and a
stable fingerprint (`org | uptime | <check id> | down`), so mute, dismiss and the pause switch all work. Alarms are
not opened while notifications are paused. When a probe passes the alarm resolves and one recovery message goes to
the channels (PagerDuty resolves the same `dedup_key`). Deleting or pausing a check closes its alarm without a message.

## SSRF

Targets are vetted at save time and again on every run with the same rules as webhooks: private, loopback,
link-local and metadata addresses are refused (`blocked_host` shown as the check's error) unless the host or CIDR
is in `HEIMDALL_ALLOW_PRIVATE_HOSTS`. TCP and TLS connect to the IP that was validated.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Status stays `pending` | Scheduler off (`HEIMDALL_DISABLE_UPTIME_JOB`), or the hub restarted less than ~20 s ago |
| `blocked_host: … private address` | Target is on your LAN: add it to `HEIMDALL_ALLOW_PRIVATE_HOSTS` |
| TLS check down with a verify error but the site works in a browser | Missing intermediate certificate on the server, or the hub cannot reach the CA chain it needs |
| Down but no notification | Alerts paused, alarm muted, or no channel configured (check the `[uptime] … DOWN` log line) |

## Limits

At most 100 checks per organization. Interval 30 s to 24 h, timeout 0.5 to 30 s.
