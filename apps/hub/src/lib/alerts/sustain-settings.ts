import { getDb } from "@/lib/db/client";
import { getOrgSettings } from "@/lib/clusters/store";
import { parseSettingsJson } from "@/lib/metrics/retention";

/** Seconds a breach must last before an alert opens. 0 = alert on the first breaching sample. */
export const DEFAULT_ALERT_SUSTAIN_SECONDS = 120;
export const MAX_ALERT_SUSTAIN_SECONDS = 3600;

export function clampAlertSustainSeconds(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_ALERT_SUSTAIN_SECONDS;
  return Math.min(MAX_ALERT_SUSTAIN_SECONDS, Math.max(0, Math.round(n)));
}

/** Hub-wide default: HEIMDALL_ALERT_SUSTAIN_DEFAULT_SECONDS, else 120. An org's saved value wins. */
function hubDefault(): number {
  const raw = process.env.HEIMDALL_ALERT_SUSTAIN_DEFAULT_SECONDS?.trim();
  if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw))) {
    return clampAlertSustainSeconds(Number(raw));
  }
  return DEFAULT_ALERT_SUSTAIN_SECONDS;
}

export async function getAlertSustainSeconds(orgId: string): Promise<number> {
  const row = await getOrgSettings(orgId);
  const saved = parseSettingsJson(row.settings_json).alertSustainSeconds;
  return typeof saved === "number" ? clampAlertSustainSeconds(saved) : hubDefault();
}

export async function setAlertSustainSeconds(orgId: string, seconds: number): Promise<number> {
  const clamped = clampAlertSustainSeconds(seconds);
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  settings.alertSustainSeconds = clamped;
  const db = await getDb();
  await db.query(
    `UPDATE org_settings SET settings_json = $2, updated_at = NOW() WHERE org_id = $1`,
    [orgId, JSON.stringify(settings)],
  );
  return clamped;
}
