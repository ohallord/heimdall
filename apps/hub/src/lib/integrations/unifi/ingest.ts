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
import { newId } from "@/lib/ids";
import { normalizeUnifiWebhook } from "./normalize";

export type UnifiIngestResult = {
  ok: true;
  eventId: string;
  severity: string;
  notified: boolean;
  suppressed?: boolean;
};

export async function ingestUnifiWebhook(input: {
  orgId: string;
  body: unknown;
}): Promise<UnifiIngestResult> {
  const normalized = normalizeUnifiWebhook(input.body);
  const fingerprint = alertFingerprint({
    orgId: input.orgId,
    ruleOrSource: "unifi",
    agentOrAlarmId: normalized.alarmId ?? "unknown",
    metricOrName: normalized.name ?? normalized.message.slice(0, 80),
  });

  if (await isFingerprintMuted(input.orgId, fingerprint)) {
    return {
      ok: true,
      eventId: "",
      severity: normalized.severity,
      notified: false,
      suppressed: true,
    };
  }

  const eventId = newId("evt");
  const payloadJson = {
    source: "unifi",
    alarmId: normalized.alarmId,
    app: normalized.app,
    name: normalized.name,
    device: normalized.device,
    category: normalized.category,
    raw: input.body,
  };

  await insertAlertEvent({
    id: eventId,
    orgId: input.orgId,
    ruleId: null,
    severity: normalized.severity,
    message: normalized.message.slice(0, 2000),
    fingerprint,
    payload: payloadJson,
  });

  let notified = false;
  if (normalized.severity === "critical") {
    const [channels, prefs] = await Promise.all([
      listAlertChannels(input.orgId),
      listNotificationPrefs(input.orgId),
    ]);
    enqueueAlert({
      channels,
      prefs,
      payload: {
        subject: `UniFi: ${normalized.name ?? "network alert"}`,
        message: normalized.message.slice(0, 500),
        severity: "critical",
        deepLink: alertDeepLink(eventId),
        fields: [
          { label: "Source", value: "unifi" },
          ...(normalized.name
            ? [{ label: "Alarm", value: normalized.name }]
            : []),
          ...(normalized.alarmId
            ? [{ label: "Alarm id", value: normalized.alarmId }]
            : []),
          ...(normalized.app
            ? [{ label: "App", value: normalized.app }]
            : []),
          ...(normalized.device
            ? [{ label: "Device", value: normalized.device }]
            : []),
          ...(normalized.category
            ? [{ label: "Category", value: normalized.category }]
            : []),
          { label: "Severity", value: "critical" },
        ],
      },
    });
    notified = true;
  }

  return { ok: true, eventId, severity: normalized.severity, notified };
}

export type UnifiEventRow = {
  id: string;
  severity: string;
  message: string;
  payload_json: string;
  created_at: string;
};

export type UnifiEventMeta = {
  name: string | null;
  device: string | null;
  category: string | null;
  app: string | null;
};

export function parseUnifiEventMeta(payloadJson: string): UnifiEventMeta {
  try {
    const p = JSON.parse(payloadJson) as {
      name?: unknown;
      device?: unknown;
      category?: unknown;
      app?: unknown;
      raw?: unknown;
    };
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : null;
    const device =
      typeof p.device === "string" && p.device.trim() ? p.device.trim() : null;
    const category =
      typeof p.category === "string" && p.category.trim()
        ? p.category.trim()
        : null;
    const app = typeof p.app === "string" && p.app.trim() ? p.app.trim() : null;
    // Legacy rows: recover device/category from raw Network parameters.
    if ((!device || !category) && p.raw && typeof p.raw === "object") {
      const raw = p.raw as Record<string, unknown>;
      const params =
        raw.parameters && typeof raw.parameters === "object"
          ? (raw.parameters as Record<string, unknown>)
          : null;
      const recoveredDevice =
        device ??
        (params && typeof params.UNIFIhost === "string"
          ? params.UNIFIhost.trim() || null
          : null);
      let recoveredCategory = category;
      if (!recoveredCategory && params) {
        const cat =
          typeof params.UNIFIcategory === "string"
            ? params.UNIFIcategory.trim()
            : "";
        const sub =
          typeof params.UNIFIsubCategory === "string"
            ? params.UNIFIsubCategory.trim()
            : "";
        if (cat && sub) recoveredCategory = `${cat} / ${sub}`;
        else if (cat) recoveredCategory = cat;
      }
      return { name, device: recoveredDevice, category: recoveredCategory, app };
    }
    return { name, device, category, app };
  } catch {
    return { name: null, device: null, category: null, app: null };
  }
}

export type UnifiGroupedBucket = {
  typeKey: string;
  devices: Array<{
    deviceKey: string;
    events: UnifiEventRow[];
  }>;
};

/** Group by alarm category (fallback: name), then device. */
export function groupUnifiEvents(events: UnifiEventRow[]): UnifiGroupedBucket[] {
  const byType = new Map<string, Map<string, UnifiEventRow[]>>();
  for (const e of events) {
    const meta = parseUnifiEventMeta(e.payload_json);
    const typeKey = meta.category || meta.name || "Other";
    const deviceKey = meta.device || "Unknown device";
    let devices = byType.get(typeKey);
    if (!devices) {
      devices = new Map();
      byType.set(typeKey, devices);
    }
    const list = devices.get(deviceKey) ?? [];
    list.push(e);
    devices.set(deviceKey, list);
  }
  return [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([typeKey, devices]) => ({
      typeKey,
      devices: [...devices.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([deviceKey, rows]) => ({ deviceKey, events: rows })),
    }));
}

export async function listUnifiAlertEvents(
  orgId: string,
  limit = 50,
): Promise<UnifiEventRow[]> {
  const db = await getDb();
  const capped = Math.min(200, Math.max(1, limit));
  // payload_json->>'source' works on Postgres; PGlite supports JSON operators.
  const result = await db.query<{
    id: string;
    severity: string;
    message: string;
    payload_json: string;
    created_at: string;
  }>(
    `SELECT id, severity, message, payload_json, created_at
     FROM alert_events
     WHERE org_id = $1
       AND payload_json LIKE '%"source":"unifi"%'
     ORDER BY created_at DESC
     LIMIT $2`,
    [orgId, capped],
  );
  return result.rows.filter((row) => {
    try {
      const p = JSON.parse(row.payload_json) as { source?: string };
      return p.source === "unifi";
    } catch {
      return false;
    }
  });
}
