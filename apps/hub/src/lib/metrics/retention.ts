import { getDb } from "@/lib/db/client";
import { getOrgSettings } from "@/lib/clusters/store";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TRACES_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MAX_TRACES_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MIN_TRACES_RETENTION_DAYS,
} from "./retention-constants";

export {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TRACES_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MAX_TRACES_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MIN_TRACES_RETENTION_DAYS,
} from "./retention-constants";

export type OrgSettingsJson = {
  metricsRetentionDays?: number;
  /** Retention for log_events and closed alert_events. */
  logsRetentionDays?: number;
  /** Retention for otel_spans, 1–60 days, default 7. */
  tracesRetentionDays?: number;
  /** When true (default), new critical findings open Alarms. */
  criticalFindingsToAlarms?: boolean;
};

export function clampRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_RETENTION_DAYS;
  return Math.min(
    MAX_RETENTION_DAYS,
    Math.max(MIN_RETENTION_DAYS, Math.round(days)),
  );
}

export function parseSettingsJson(raw: string | null | undefined): OrgSettingsJson {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as OrgSettingsJson;
  } catch {
    return {};
  }
}

export async function getMetricsRetentionDays(orgId: string): Promise<number> {
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  if (settings.metricsRetentionDays == null) return DEFAULT_RETENTION_DAYS;
  return clampRetentionDays(settings.metricsRetentionDays);
}

export async function setMetricsRetentionDays(
  orgId: string,
  days: number,
): Promise<number> {
  const clamped = clampRetentionDays(days);
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  settings.metricsRetentionDays = clamped;
  const db = await getDb();
  await db.query(
    `UPDATE org_settings
     SET settings_json = $2, updated_at = NOW()
     WHERE org_id = $1`,
    [orgId, JSON.stringify(settings)],
  );
  return clamped;
}

export async function getLogsRetentionDays(orgId: string): Promise<number> {
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  if (settings.logsRetentionDays == null) return DEFAULT_RETENTION_DAYS;
  return clampRetentionDays(settings.logsRetentionDays);
}

export async function setLogsRetentionDays(
  orgId: string,
  days: number,
): Promise<number> {
  const clamped = clampRetentionDays(days);
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  settings.logsRetentionDays = clamped;
  const db = await getDb();
  await db.query(
    `UPDATE org_settings
     SET settings_json = $2, updated_at = NOW()
     WHERE org_id = $1`,
    [orgId, JSON.stringify(settings)],
  );
  return clamped;
}

/**
 * Delete log lines and closed (non-open) alert events older than the org's
 * logs retention. Open alarms are never purged.
 */
export async function purgeOrgLogsAndAlerts(
  orgId: string,
  now = Date.now(),
): Promise<{ logs: number; alerts: number }> {
  const days = await getLogsRetentionDays(orgId);
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();
  const logs = await db.query(
    `DELETE FROM log_events WHERE org_id = $1 AND observed_at < $2 RETURNING id`,
    [orgId, cutoff],
  );
  const alerts = await db.query(
    `DELETE FROM alert_events
     WHERE org_id = $1 AND created_at < $2 AND status <> 'open'
     RETURNING id`,
    [orgId, cutoff],
  );
  return { logs: logs.rowCount ?? 0, alerts: alerts.rowCount ?? 0 };
}

/** Purge every org; used by the scheduled job so idle orgs are cleaned too. */
export async function purgeAllOrgs(now = Date.now()): Promise<void> {
  const db = await getDb();
  const orgs = await db.query<{ id: string }>(`SELECT id FROM organizations`);
  const { purgeOtelMetrics } = await import("@/lib/otel/ingest");
  const { purgeOtelSpans } = await import("@/lib/otel/traces");
  for (const { id } of orgs.rows) {
    await maybePurgeOrgMetrics(id, now);
    await purgeOtelMetrics(id, now);
    await purgeOrgLogsAndAlerts(id, now);
    await purgeOtelSpans(id, now);
  }
}

const lastPurgeByOrg = new Map<string, number>();
const PURGE_COOLDOWN_MS = 60 * 60 * 1000;

/** Throttled purge of samples older than org retention. */
export async function maybePurgeOrgMetrics(
  orgId: string,
  now = Date.now(),
): Promise<number> {
  const prev = lastPurgeByOrg.get(orgId);
  if (prev != null && now - prev < PURGE_COOLDOWN_MS) return 0;
  lastPurgeByOrg.set(orgId, now);

  const days = await getMetricsRetentionDays(orgId);
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();
  const result = await db.query(
    `DELETE FROM agent_metric_samples
     WHERE org_id = $1 AND collected_at < $2`,
    [orgId, cutoff],
  );
  return result.rowCount ?? 0;
}

/** Test helper */
export function resetPurgeCooldowns(): void {
  lastPurgeByOrg.clear();
}

export function clampTracesRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_TRACES_RETENTION_DAYS;
  return Math.min(
    MAX_TRACES_RETENTION_DAYS,
    Math.max(MIN_TRACES_RETENTION_DAYS, Math.round(days)),
  );
}

export async function getTracesRetentionDays(orgId: string): Promise<number> {
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  if (settings.tracesRetentionDays == null) return DEFAULT_TRACES_RETENTION_DAYS;
  return clampTracesRetentionDays(settings.tracesRetentionDays);
}

export async function setTracesRetentionDays(
  orgId: string,
  days: number,
): Promise<number> {
  const clamped = clampTracesRetentionDays(days);
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  settings.tracesRetentionDays = clamped;
  const db = await getDb();
  await db.query(
    `UPDATE org_settings
     SET settings_json = $2, updated_at = NOW()
     WHERE org_id = $1`,
    [orgId, JSON.stringify(settings)],
  );
  return clamped;
}
