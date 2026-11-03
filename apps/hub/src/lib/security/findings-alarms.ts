import { alertFingerprint } from "@/lib/alerts/fingerprint";
import { alertDeepLink } from "@/lib/alerts/format";
import { enqueueAlert } from "@/lib/alerts/queue";
import { getDb } from "@/lib/db/client";
import {
  insertAlertEvent,
  isFingerprintMuted,
  listAlertChannels,
  listNotificationPrefs,
} from "@/lib/db/store";
import type { VulnFindingRow } from "@/lib/db/types";
import { newId } from "@/lib/ids";
import { getCriticalFindingsToAlarms } from "./settings";

export function findingAlertFingerprint(input: {
  orgId: string;
  source: string;
  agentId: string | null;
  resource: string | null;
  externalId: string;
}): string {
  return alertFingerprint({
    orgId: input.orgId,
    ruleOrSource: `finding:${input.source}`,
    agentOrAlarmId: input.agentId?.trim() || input.resource?.trim() || "none",
    metricOrName: input.externalId,
  });
}

async function hasActiveFingerprintAlarm(
  orgId: string,
  fingerprint: string,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ id: string }>(
    `SELECT id FROM alert_events
     WHERE org_id = $1 AND fingerprint = $2 AND status IN ('open', 'muted')
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, fingerprint],
  );
  return Boolean(result.rows[0]);
}

/**
 * Raise an Alarm for a newly ingested critical finding when the org setting
 * is enabled. No-ops for non-critical, muted fingerprints, or existing open alarms.
 */
export async function maybeRaiseFindingAlarm(
  orgId: string,
  finding: Pick<
    VulnFindingRow,
    | "id"
    | "source"
    | "external_id"
    | "title"
    | "severity"
    | "resource"
    | "cve"
    | "agent_id"
    | "package_name"
  >,
): Promise<{ raised: boolean; eventId?: string; suppressed?: boolean }> {
  if (finding.severity !== "critical") {
    return { raised: false };
  }
  if (!(await getCriticalFindingsToAlarms(orgId))) {
    return { raised: false, suppressed: true };
  }

  const fingerprint = findingAlertFingerprint({
    orgId,
    source: finding.source,
    agentId: finding.agent_id,
    resource: finding.resource,
    externalId: finding.external_id,
  });

  if (await isFingerprintMuted(orgId, fingerprint)) {
    return { raised: false, suppressed: true };
  }
  if (await hasActiveFingerprintAlarm(orgId, fingerprint)) {
    return { raised: false, suppressed: true };
  }

  const eventId = newId("evt");
  const message = `${finding.severity} ${finding.source}: ${finding.title}`.slice(
    0,
    2000,
  );
  await insertAlertEvent({
    id: eventId,
    orgId,
    ruleId: null,
    severity: "critical",
    message,
    fingerprint,
    payload: {
      source: "finding",
      findingId: finding.id,
      findingSource: finding.source,
      externalId: finding.external_id,
      cve: finding.cve,
      resource: finding.resource,
      agentId: finding.agent_id,
      packageName: finding.package_name,
    },
  });

  const [channels, prefs] = await Promise.all([
    listAlertChannels(orgId),
    listNotificationPrefs(orgId),
  ]);
  enqueueAlert({
    channels,
    prefs,
    payload: {
      subject: `Critical finding: ${finding.title}`.slice(0, 200),
      message: message.slice(0, 500),
      severity: "critical",
      deepLink: alertDeepLink(eventId),
      fields: [
        { label: "Source", value: finding.source },
        ...(finding.cve ? [{ label: "CVE", value: finding.cve }] : []),
        ...(finding.resource
          ? [{ label: "Resource", value: finding.resource }]
          : []),
        ...(finding.package_name
          ? [{ label: "Package", value: finding.package_name }]
          : []),
        ...(finding.agent_id
          ? [{ label: "Agent", value: finding.agent_id }]
          : []),
        { label: "Finding", value: finding.id },
        { label: "Severity", value: "critical" },
      ],
    },
  });

  return { raised: true, eventId };
}
