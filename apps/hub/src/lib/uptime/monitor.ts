import { areAlertsPaused } from "@/lib/alerts/pause";
import { getAlertSustainSeconds } from "@/lib/alerts/sustain-settings";
import { alertFingerprint } from "@/lib/alerts/fingerprint";
import { alertDeepLink, formatTimestamp } from "@/lib/alerts/format";
import { enqueueAlert } from "@/lib/alerts/queue";
import { getDb } from "@/lib/db/client";
import { insertAlertEvent, isFingerprintMuted, listAlertChannels, listNotificationPrefs } from "@/lib/db/store";
import { newId } from "@/lib/ids";
import { runProbe, type ProbeCheck, type ProbeResult } from "./probe";
import type { UptimeCheckRow } from "./store";

/** Probes run at most this many at a time per pass. */
const CONCURRENCY = 8;
const MAX_ERROR_LEN = 300;

export type MonitorDeps = {
  probe?: (check: ProbeCheck) => Promise<ProbeResult>;
};

/** Stable alarm identity for a check going down; the same value dedupes PagerDuty. */
export function uptimeFingerprint(orgId: string, checkId: string): string {
  return alertFingerprint({ orgId, ruleOrSource: "uptime", agentOrAlarmId: checkId, metricOrName: "down" });
}

async function activeEvent(orgId: string, fingerprint: string): Promise<{ id: string; created_at: string } | null> {
  const db = await getDb();
  const r = await db.query<{ id: string; created_at: string }>(
    `SELECT id, created_at FROM alert_events
     WHERE org_id = $1 AND fingerprint = $2 AND status IN ('open', 'muted')
     ORDER BY created_at DESC LIMIT 1`,
    [orgId, fingerprint],
  );
  return r.rows[0] ?? null;
}

/** Resolve the open alarm for a check without notifying (check deleted or disabled). */
export async function resolveUptimeAlarmSilently(orgId: string, checkId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE alert_events SET status = 'resolved', resolved_at = NOW(), muted_until = NULL
     WHERE org_id = $1 AND fingerprint = $2 AND status IN ('open', 'muted')`,
    [orgId, uptimeFingerprint(orgId, checkId)],
  );
}

function targetHost(check: Pick<UptimeCheckRow, "kind" | "target">): string {
  if (check.kind === "http") {
    try {
      return new URL(check.target).host;
    } catch {
      return check.target;
    }
  }
  return check.target;
}

/**
 * Down = failing for the org sustain window (a window of 0 means the first failure) AND confirmed by
 * at least two consecutive failed probes when the window is non-zero, so one dropped packet never pages.
 */
export function isDown(
  c: { consecutiveFailures: number; failingSince: Date | null },
  sustainSeconds: number,
  now: Date,
): boolean {
  if (c.consecutiveFailures < 1 || !c.failingSince) return false;
  if (sustainSeconds === 0) return true;
  return c.consecutiveFailures >= 2 && now.getTime() - c.failingSince.getTime() >= sustainSeconds * 1000;
}

async function openDownAlarm(check: UptimeCheckRow, error: string, failures: number, fingerprint: string): Promise<void> {
  if (areAlertsPaused()) return;
  if (await isFingerprintMuted(check.org_id, fingerprint)) return;
  if (await activeEvent(check.org_id, fingerprint)) return;
  const eventId = newId("evt");
  const host = targetHost(check);
  const message = `${check.name} is down: ${error}`.slice(0, 2000);
  const payload = {
    subject: `${check.name} is down`,
    message: `${check.kind.toUpperCase()} check of ${check.target} failed: ${error}`,
    severity: "critical" as const,
    hostname: host,
    deepLink: alertDeepLink(eventId),
    dedupKey: fingerprint,
    fields: [
      { label: "Check", value: check.name },
      { label: "Type", value: check.kind },
      { label: "Target", value: check.target },
      { label: "Error", value: error },
      { label: "Consecutive failures", value: String(failures) },
      { label: "Started", value: formatTimestamp(new Date()) },
    ],
  };
  // Insert first: a failed insert must not notify for an alarm that does not exist.
  await insertAlertEvent({
    id: eventId,
    orgId: check.org_id,
    severity: "critical",
    message,
    fingerprint,
    payload: {
      source: "uptime",
      uptimeCheckId: check.id,
      hostname: host,
      name: check.name,
      kind: check.kind,
      target: check.target,
      error,
    },
  });
  const [channels, prefs] = await Promise.all([listAlertChannels(check.org_id), listNotificationPrefs(check.org_id)]);
  enqueueAlert({ channels, payload, prefs });
  console.warn(`[uptime] org=${check.org_id} check=${check.id} DOWN ${check.kind} ${check.target}: ${error}`);
}

async function resolveDownAlarm(check: UptimeCheckRow, fingerprint: string, now: Date): Promise<void> {
  const open = await activeEvent(check.org_id, fingerprint);
  if (!open) return;
  const db = await getDb();
  // Conditional on status so two passes cannot both resolve (and notify).
  const res = await db.query<{ id: string }>(
    `UPDATE alert_events SET status = 'resolved', resolved_at = $3, muted_until = NULL
     WHERE org_id = $1 AND id = $2 AND status IN ('open', 'muted') RETURNING id`,
    [check.org_id, open.id, now.toISOString()],
  );
  if (res.rows.length === 0) return;
  const host = targetHost(check);
  const mins = Math.max(1, Math.round((now.getTime() - new Date(open.created_at).getTime()) / 60_000));
  const [channels, prefs] = await Promise.all([listAlertChannels(check.org_id), listNotificationPrefs(check.org_id)]);
  enqueueAlert({
    channels,
    prefs,
    payload: {
      kind: "recovery",
      severity: "info",
      subject: `${check.name} is up`,
      message: `${check.name} (${check.target}) is reachable again after about ${mins} min.`,
      hostname: host,
      deepLink: alertDeepLink(open.id),
      dedupKey: fingerprint,
      fields: [
        { label: "Check", value: check.name },
        { label: "Target", value: check.target },
        { label: "Recovered", value: formatTimestamp(now) },
      ],
    },
  });
  console.log(`[uptime] org=${check.org_id} check=${check.id} UP ${check.kind} ${check.target} (recovered)`);
}

/** Store one result, then open or resolve the alarm. */
export async function recordUptimeResult(
  check: UptimeCheckRow,
  result: ProbeResult,
  now: Date,
  sustainSeconds?: number,
): Promise<void> {
  const db = await getDb();
  const error = result.ok ? null : (result.error ?? "check failed").slice(0, MAX_ERROR_LEN);
  const failures = result.ok ? 0 : check.consecutive_failures + 1;
  const failingSince = result.ok ? null : (check.failing_since ? new Date(check.failing_since) : now);
  await db.query(
    `UPDATE uptime_checks
     SET last_status = $2, last_latency_ms = $3, last_error = $4,
         consecutive_failures = $5, failing_since = $6::timestamptz
     WHERE id = $1`,
    [check.id, result.ok ? "up" : "down", result.latencyMs, error, failures, failingSince ? failingSince.toISOString() : null],
  );
  const fingerprint = uptimeFingerprint(check.org_id, check.id);
  if (result.ok) {
    await resolveDownAlarm(check, fingerprint, now);
    return;
  }
  const sustain = sustainSeconds ?? (await getAlertSustainSeconds(check.org_id));
  if (isDown({ consecutiveFailures: failures, failingSince }, sustain, now)) {
    await openDownAlarm(check, error ?? "check failed", failures, fingerprint);
  }
}

/**
 * One scheduler pass. A check is due when it never ran or last_run_at + interval has passed. Each is
 * claimed with a compare-and-swap on last_run_at, so a tick runs once even with two pollers or a
 * restart. Returns the ids of the checks this pass ran.
 */
export async function runDueUptimeChecks(now: Date = new Date(), deps: MonitorDeps = {}): Promise<string[]> {
  const db = await getDb();
  const rows = (
    await db.query<UptimeCheckRow>(
      `SELECT * FROM uptime_checks
       WHERE enabled = TRUE
         AND (last_run_at IS NULL OR last_run_at + (interval_seconds * INTERVAL '1 second') <= $1::timestamptz)
       ORDER BY created_at ASC, id ASC`,
      [now.toISOString()],
    )
  ).rows;

  const claimed: UptimeCheckRow[] = [];
  for (const row of rows) {
    const prev = row.last_run_at ? new Date(row.last_run_at).toISOString() : null;
    const won = await db.query<{ id: string }>(
      `UPDATE uptime_checks SET last_run_at = $2::timestamptz
       WHERE id = $1 AND enabled = TRUE AND last_run_at IS NOT DISTINCT FROM $3::timestamptz
       RETURNING id`,
      [row.id, now.toISOString(), prev],
    );
    if (won.rows.length > 0) claimed.push(row);
  }

  const probe = deps.probe ?? ((c: ProbeCheck) => runProbe(c));
  const sustainByOrg = new Map<string, number>();
  const queue = [...claimed];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const result = await probe(row);
        if (!sustainByOrg.has(row.org_id)) sustainByOrg.set(row.org_id, await getAlertSustainSeconds(row.org_id));
        await recordUptimeResult(row, result, now, sustainByOrg.get(row.org_id));
      } catch (err) {
        console.error(`[uptime] check=${row.id} pass failed`, err instanceof Error ? err.message : err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, worker));
  return claimed.map((c) => c.id);
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** Poll every 15s from instrumentation. Overlapping passes in one process are skipped. */
export function startUptimeScheduler(intervalMs = 15_000): void {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueUptimeChecks();
    } catch (err) {
      console.error("[uptime] scheduler pass failed", err);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 20_000).unref?.();
  console.log("[uptime] scheduler started");
}
