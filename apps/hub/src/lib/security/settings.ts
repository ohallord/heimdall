import { getDb } from "@/lib/db/client";
import { getOrgSettings } from "@/lib/clusters/store";
import {
  parseSettingsJson,
  type OrgSettingsJson,
} from "@/lib/metrics/retention";

/** Default on: critical findings raise Alarms. */
export const DEFAULT_CRITICAL_FINDINGS_TO_ALARMS = true;

export function criticalFindingsToAlarmsEnabled(
  settings: OrgSettingsJson,
): boolean {
  if (settings.criticalFindingsToAlarms === false) return false;
  if (settings.criticalFindingsToAlarms === true) return true;
  return DEFAULT_CRITICAL_FINDINGS_TO_ALARMS;
}

export async function getCriticalFindingsToAlarms(
  orgId: string,
): Promise<boolean> {
  const row = await getOrgSettings(orgId);
  return criticalFindingsToAlarmsEnabled(parseSettingsJson(row.settings_json));
}

export async function setCriticalFindingsToAlarms(
  orgId: string,
  enabled: boolean,
): Promise<boolean> {
  const row = await getOrgSettings(orgId);
  const settings = parseSettingsJson(row.settings_json);
  settings.criticalFindingsToAlarms = enabled;
  const db = await getDb();
  await db.query(
    `UPDATE org_settings
     SET settings_json = $2, updated_at = NOW()
     WHERE org_id = $1`,
    [orgId, JSON.stringify(settings)],
  );
  return enabled;
}
