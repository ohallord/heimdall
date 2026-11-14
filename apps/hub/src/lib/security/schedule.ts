import { getDb } from "@/lib/db/client";
import { DEFAULT_SECURITY_SYNC_CRON, isValidTimeZone, nextCronRun, validateCron } from "./cron";
import { ingestSecurityScan } from "./sync";

export type SecuritySyncRunStatus = "running" | "ok" | "warnings" | "error";

export type SecuritySyncScheduleView = {
  cron: string;
  enabled: boolean;
  timeZone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: SecuritySyncRunStatus | null;
  lastRunWritten: number | null;
  lastRunWarnings: string[];
  lastRunDurationMs: number | null;
};

type Row = {
  org_id: string;
  cron: string;
  enabled: boolean;
  time_zone: string | null;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
  last_run_status: SecuritySyncRunStatus | null;
  last_run_written: number | null;
  last_run_warnings: string;
  last_run_duration_ms: number | null;
};

const MAX_STORED_WARNINGS = 50;

/** HEIMDALL_TZ, else TZ, else the server's zone. Invalid names are skipped. */
export function hubTimeZone(): string {
  for (const v of [process.env.HEIMDALL_TZ, process.env.TZ]) {
    const tz = v?.trim();
    if (tz && isValidTimeZone(tz)) return tz;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const toIso = (v: Date | string | null): string | null =>
  v == null ? null : new Date(v).toISOString();

function computeNext(cron: string, now: Date, tz: string): string | null {
  return toIso(nextCronRun(cron, now, tz));
}

function parseWarnings(text: string | null): string[] {
  try {
    const v = JSON.parse(text ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function readRow(orgId: string): Promise<Row | null> {
  const db = await getDb();
  const r = await db.query<Row>(`SELECT * FROM security_sync_schedules WHERE org_id = $1`, [orgId]);
  return r.rows[0] ?? null;
}

export async function getSecuritySyncSchedule(
  orgId: string,
  now: Date = new Date(),
): Promise<SecuritySyncScheduleView> {
  const tz = hubTimeZone();
  const row = await readRow(orgId);
  const cron = row?.cron ?? DEFAULT_SECURITY_SYNC_CRON;
  const enabled = row?.enabled ?? true;
  let nextRunAt: string | null = null;
  if (enabled) {
    nextRunAt =
      row?.next_run_at && row.time_zone === tz ? toIso(row.next_run_at) : computeNext(cron, now, tz);
  }
  return {
    cron,
    enabled,
    timeZone: tz,
    nextRunAt,
    lastRunAt: toIso(row?.last_run_at ?? null),
    lastRunStatus: row?.last_run_status ?? null,
    lastRunWritten: row?.last_run_written ?? null,
    lastRunWarnings: parseWarnings(row?.last_run_warnings ?? null),
    lastRunDurationMs: row?.last_run_duration_ms ?? null,
  };
}

export async function saveSecuritySyncSchedule(
  orgId: string,
  input: { cron: string; enabled: boolean; updatedBy?: string | null },
  now: Date = new Date(),
): Promise<SecuritySyncScheduleView> {
  const cron = input.cron.trim().split(/\s+/).join(" ");
  const reason = validateCron(cron);
  if (reason) throw Object.assign(new Error(`invalid cron: ${reason}`), { status: 400 });
  const tz = hubTimeZone();
  const next = input.enabled ? computeNext(cron, now, tz) : null;
  const db = await getDb();
  await db.query(
    `INSERT INTO security_sync_schedules (org_id, cron, enabled, time_zone, next_run_at, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, NOW())
     ON CONFLICT (org_id) DO UPDATE SET
       cron = EXCLUDED.cron, enabled = EXCLUDED.enabled, time_zone = EXCLUDED.time_zone,
       next_run_at = EXCLUDED.next_run_at, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [orgId, cron, input.enabled, tz, next, input.updatedBy ?? null],
  );
  console.log(
    `[security-sync] org=${orgId} schedule saved cron="${cron}" tz=${tz} enabled=${input.enabled} next=${next ?? "-"}`,
  );
  return getSecuritySyncSchedule(orgId, now);
}

/**
 * One scheduler pass: give new orgs the default schedule, (re)compute next runs that are missing
 * or were computed in another time zone, then claim and run each due org. A claim moves
 * next_run_at forward only if it still holds the value this pass read, so two pollers (or a
 * restarted hub) never run the same tick twice. Returns the org ids this pass ran.
 */
export async function runDueSecuritySyncs(now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const tz = hubTimeZone();
  await db.query(
    `INSERT INTO security_sync_schedules (org_id) SELECT id FROM organizations ON CONFLICT (org_id) DO NOTHING`,
  );
  const rows = (
    await db.query<Row>(`SELECT * FROM security_sync_schedules WHERE enabled = TRUE ORDER BY org_id`)
  ).rows;

  const ran: string[] = [];
  for (const row of rows) {
    const prev = toIso(row.next_run_at);
    if (!prev || row.time_zone !== tz) {
      await db.query(
        `UPDATE security_sync_schedules SET next_run_at = $2::timestamptz, time_zone = $3
         WHERE org_id = $1 AND next_run_at IS NOT DISTINCT FROM $4::timestamptz`,
        [row.org_id, computeNext(row.cron, now, tz), tz, prev],
      );
      continue;
    }
    if (new Date(prev).getTime() > now.getTime()) continue;

    const claimed = await db.query<{ org_id: string }>(
      `UPDATE security_sync_schedules
       SET next_run_at = $2::timestamptz, last_run_at = $3::timestamptz, last_run_status = 'running'
       WHERE org_id = $1 AND enabled = TRUE AND next_run_at = $4::timestamptz
       RETURNING org_id`,
      [row.org_id, computeNext(row.cron, now, tz), now.toISOString(), prev],
    );
    if (claimed.rows.length === 0) continue;
    ran.push(row.org_id);
    await runOne(row.org_id, row.cron);
  }
  return ran;
}

async function runOne(orgId: string, cron: string): Promise<void> {
  const db = await getDb();
  const started = Date.now();
  let status: SecuritySyncRunStatus;
  let written: number | null = null;
  let warnings: string[];
  try {
    const r = await ingestSecurityScan({ orgId, syncRemotes: true });
    written = r.written;
    warnings = r.errors;
    status = warnings.length > 0 ? "warnings" : "ok";
  } catch (err) {
    status = "error";
    warnings = [err instanceof Error ? err.message : "sync failed"];
  }
  const duration = Date.now() - started;
  const line = `[security-sync] org=${orgId} scheduled run (${cron}) status=${status} written=${written ?? 0} warnings=${warnings.length} duration=${duration}ms`;
  if (status === "error") console.error(`${line}: ${warnings[0]}`);
  else console.log(line);
  await db.query(
    `UPDATE security_sync_schedules
     SET last_run_status = $2, last_run_written = $3, last_run_warnings = $4, last_run_duration_ms = $5
     WHERE org_id = $1`,
    [orgId, status, written, JSON.stringify(warnings.slice(0, MAX_STORED_WARNINGS)), duration],
  );
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** Poll every minute from instrumentation. Overlapping passes in one process are skipped. */
export function startSecuritySyncScheduler(intervalMs = 60_000): void {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueSecuritySyncs();
    } catch (err) {
      console.error("[security-sync] scheduler pass failed", err);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
  console.log(`[security-sync] scheduler started tz=${hubTimeZone()}`);
}
