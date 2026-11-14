# Audit log

The hub records administrative changes in the `audit_log` table so you can answer "who changed this?".

## What is recorded

| Action | Where it comes from |
| --- | --- |
| `security.sync_schedule.update` | Settings → security sync schedule |
| `org.settings.update` | `PATCH /api/v1/org/settings` (retention, sustain window, critical findings → alarms) |
| `alert.rule.update` | `PATCH /api/v1/alerts/rules/:id` |
| `agent_token.create` / `.revoke` / `.replace` | Enrollment tokens |
| `bootstrap_token.rotate` / `.disable` / `.revert` | Bootstrap token mode |
| `oidc.provider.save` | Admin → OIDC |
| `backup.export` / `backup.restore` | Admin → Backup (export records whether secrets were included) |
| `security.connection.add` | GitHub/GitLab remotes (settings and setup wizard) |
| `alert_channel.save` | Alert channels (setup wizard) |
| `uptime.check.create` / `.update` / `.delete` | Dashboard → Uptime |

Not recorded: logins (success or failure). There are no remove endpoints yet for OIDC providers, remotes or
alert channels, so those have no `.delete` action today.

Each row has the org, actor (user id and email copied at the time), action, target id, a JSON `detail` and the
client IP (only when `HEIMDALL_TRUST_PROXY` is set, otherwise `unknown`/null).

Secrets are never stored: detail keys that look secret (`token`, `secret`, `password`, `apiKey`, `webhook`, …)
are replaced by `[redacted]` before writing, and call sites only pass the changed field names and values.

## Reading it

Dashboard → Admin → Audit log, or:

```bash
curl -s -b cookies.txt 'https://hub.example/api/v1/admin/audit?action=org.settings.update&limit=50'
```

Admin only (`settings:write`). Pass the returned `nextCursor` as `cursor` for the next page.

## Retention

Rows older than the org's **logs retention** (Settings, default 60 days) are deleted by the scheduled purge,
together with log lines and closed alarms.

## Failure behaviour

`recordAudit()` never throws into the caller: if the insert fails the change still succeeds and the hub logs
`[audit] failed to record entry …`. Alert on that line if audit completeness matters.
