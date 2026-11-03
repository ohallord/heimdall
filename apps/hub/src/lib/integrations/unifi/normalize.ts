export type UnifiSeverity = "info" | "warning" | "critical";

export type NormalizedUnifiAlert = {
  message: string;
  severity: UnifiSeverity;
  alarmId: string | null;
  app: string | null;
  name: string | null;
  /** Device hostname / MAC when present (Network UNIFIhost or Protect trigger). */
  device: string | null;
  /** Alarm Manager category (e.g. Internet); null for Protect-shaped payloads. */
  category: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length ? t : null;
}

function mapSeverity(raw: unknown, name: string | null, message: string): UnifiSeverity {
  if (typeof raw === "number") {
    if (raw >= 3) return "critical";
    if (raw >= 2) return "warning";
    return "info";
  }
  if (typeof raw === "string") {
    const s = raw.toLowerCase();
    if (s.includes("crit") || s.includes("error") || s === "high") return "critical";
    if (s.includes("warn") || s === "medium") return "warning";
    if (s.includes("info") || s === "low") return "info";
  }
  const hay = `${name ?? ""} ${message}`.toLowerCase();
  if (
    hay.includes("offline") ||
    hay.includes("disconnected") ||
    hay.includes("outage") ||
    hay.includes("failover")
  ) {
    return "critical";
  }
  return "warning";
}

function protectMessage(alarm: Record<string, unknown>): string {
  const name = str(alarm.name) ?? "UniFi Protect alarm";
  const triggers = Array.isArray(alarm.triggers) ? alarm.triggers : [];
  const parts: string[] = [];
  for (const t of triggers) {
    const row = asRecord(t);
    if (!row) continue;
    const key = str(row.key);
    const device = str(row.device);
    if (key && device) parts.push(`${key} @ ${device}`);
    else if (key) parts.push(key);
  }
  return parts.length ? `${name}: ${parts.join(", ")}` : name;
}

function firstProtectDevice(alarm: Record<string, unknown>): string | null {
  const triggers = Array.isArray(alarm.triggers) ? alarm.triggers : [];
  for (const t of triggers) {
    const row = asRecord(t);
    if (!row) continue;
    const device = str(row.device);
    if (device) return device;
  }
  return null;
}

function networkCategory(params: Record<string, unknown> | null): string | null {
  if (!params) return null;
  const cat = str(params.UNIFIcategory);
  const sub = str(params.UNIFIsubCategory);
  if (cat && sub) return `${cat} / ${sub}`;
  return cat;
}

/**
 * Best-effort normalize for Network Alarm Manager and Protect-shaped webhooks.
 * Always keep callers storing the raw body separately.
 */
export function normalizeUnifiWebhook(body: unknown): NormalizedUnifiAlert {
  const root = asRecord(body) ?? {};

  // Protect-style: { alarm: { name, triggers, ... }, timestamp }
  const alarm = asRecord(root.alarm);
  if (alarm) {
    const name = str(alarm.name);
    const message = protectMessage(alarm);
    return {
      message,
      severity: mapSeverity(root.severity ?? alarm.severity, name, message),
      alarmId: str(root.alarm_id) ?? str(alarm.id),
      app: str(root.app) ?? "protect",
      name,
      device: firstProtectDevice(alarm),
      category: null,
    };
  }

  // Network flat: { app, name, message, severity, alarm_id, parameters, ... }
  const name = str(root.name);
  const message =
    str(root.message) ??
    str(root.customContent) ??
    name ??
    "UniFi network alert";
  const params = asRecord(root.parameters);
  return {
    message,
    severity: mapSeverity(root.severity, name, message),
    alarmId: str(root.alarm_id) ?? str(root.id),
    app: str(root.app) ?? "network",
    name,
    device: params ? str(params.UNIFIhost) : null,
    category: networkCategory(params),
  };
}
