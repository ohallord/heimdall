import { getDb } from "@/lib/db/client";
import { newId } from "@/lib/ids";
import { parseHostPort, type UptimeKind } from "./probe";

export type UptimeCheckRow = {
  id: string;
  org_id: string;
  name: string;
  kind: UptimeKind;
  target: string;
  interval_seconds: number;
  timeout_ms: number;
  expected_status: number | null;
  tls_warn_days: number;
  enabled: boolean;
  last_run_at: string | Date | null;
  last_status: "up" | "down" | null;
  last_latency_ms: number | null;
  last_error: string | null;
  consecutive_failures: number;
  failing_since: string | Date | null;
  created_by: string | null;
  created_at: string | Date;
};

export type UptimeCheckView = {
  id: string;
  name: string;
  kind: UptimeKind;
  target: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number | null;
  tlsWarnDays: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "up" | "down" | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export const MAX_UPTIME_CHECKS_PER_ORG = 100;
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86_400;

const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

export function toView(r: UptimeCheckRow): UptimeCheckView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    target: r.target,
    intervalSeconds: r.interval_seconds,
    timeoutMs: r.timeout_ms,
    expectedStatus: r.expected_status,
    tlsWarnDays: r.tls_warn_days,
    enabled: r.enabled,
    lastRunAt: iso(r.last_run_at),
    lastStatus: r.last_status,
    lastLatencyMs: r.last_latency_ms,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
  };
}

export type UptimeCheckInput = {
  name: string;
  kind: UptimeKind;
  target: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  expectedStatus?: number | null;
  tlsWarnDays?: number;
};

/** Returns an error message, or null when the input is a usable check. */
export function validateUptimeInput(i: UptimeCheckInput): string | null {
  if (!i.name.trim() || i.name.length > 80) return "name must be 1-80 characters";
  if (i.kind === "http") {
    let u: URL;
    try {
      u = new URL(i.target);
    } catch {
      return "http target must be an http(s) URL";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "http target must be an http(s) URL";
    if (i.expectedStatus != null && (!Number.isInteger(i.expectedStatus) || i.expectedStatus < 100 || i.expectedStatus > 599)) {
      return "expectedStatus must be 100-599";
    }
  } else if (i.kind === "tcp") {
    if (!parseHostPort(i.target)) return "tcp target must be host:port";
    if (i.expectedStatus != null) return "expectedStatus only applies to http checks";
  } else {
    if (!parseHostPort(i.target, 443)) return "tls target must be host or host:port";
    if (i.expectedStatus != null) return "expectedStatus only applies to http checks";
  }
  const interval = i.intervalSeconds ?? 60;
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
    return `intervalSeconds must be ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS}`;
  }
  const timeout = i.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 30_000) return "timeoutMs must be 500-30000";
  const warn = i.tlsWarnDays ?? 14;
  if (!Number.isInteger(warn) || warn < 1 || warn > 365) return "tlsWarnDays must be 1-365";
  return null;
}

/** The URL whose host the SSRF guard should vet at save time. */
export function guardUrlFor(i: Pick<UptimeCheckInput, "kind" | "target">): string | null {
  if (i.kind === "http") return i.target;
  const hp = parseHostPort(i.target, i.kind === "tls" ? 443 : undefined);
  if (!hp) return null;
  return `http://${hp.host.includes(":") ? `[${hp.host}]` : hp.host}:${hp.port}/`;
}

export async function listUptimeChecks(orgId: string): Promise<UptimeCheckRow[]> {
  const db = await getDb();
  const r = await db.query<UptimeCheckRow>(`SELECT * FROM uptime_checks WHERE org_id = $1 ORDER BY created_at ASC, id ASC`, [orgId]);
  return r.rows;
}

export async function getUptimeCheck(orgId: string, id: string): Promise<UptimeCheckRow | null> {
  const db = await getDb();
  const r = await db.query<UptimeCheckRow>(`SELECT * FROM uptime_checks WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return r.rows[0] ?? null;
}

export async function createUptimeCheck(
  orgId: string,
  input: UptimeCheckInput & { enabled?: boolean; createdBy?: string | null },
): Promise<UptimeCheckRow> {
  const problem = validateUptimeInput(input);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const db = await getDb();
  const count = await db.query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM uptime_checks WHERE org_id = $1`, [orgId]);
  if (Number(count.rows[0]?.n ?? 0) >= MAX_UPTIME_CHECKS_PER_ORG) {
    throw Object.assign(new Error(`at most ${MAX_UPTIME_CHECKS_PER_ORG} uptime checks per organization`), { status: 400 });
  }
  const id = newId("upt");
  await db.query(
    `INSERT INTO uptime_checks (id, org_id, name, kind, target, interval_seconds, timeout_ms, expected_status, tls_warn_days, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      orgId,
      input.name.trim(),
      input.kind,
      input.target.trim(),
      input.intervalSeconds ?? 60,
      input.timeoutMs ?? 5000,
      input.kind === "http" ? (input.expectedStatus ?? null) : null,
      input.tlsWarnDays ?? 14,
      input.enabled ?? true,
      input.createdBy ?? null,
    ],
  );
  return (await getUptimeCheck(orgId, id))!;
}

export async function setUptimeCheckEnabled(orgId: string, id: string, enabled: boolean): Promise<UptimeCheckRow | null> {
  const db = await getDb();
  await db.query(
    // Re-enabling restarts the failure streak so a stale one cannot instantly alarm.
    `UPDATE uptime_checks SET enabled = $3,
       consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures END,
       failing_since = CASE WHEN $3 THEN NULL ELSE failing_since END,
       last_run_at = CASE WHEN $3 THEN NULL ELSE last_run_at END
     WHERE org_id = $1 AND id = $2`,
    [orgId, id, enabled],
  );
  return getUptimeCheck(orgId, id);
}

export async function deleteUptimeCheck(orgId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(`DELETE FROM uptime_checks WHERE org_id = $1 AND id = $2 RETURNING id`, [orgId, id]);
  return (r.rowCount ?? 0) > 0;
}
