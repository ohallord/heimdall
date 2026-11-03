import type { AlertEventRow } from "@/lib/db/types";

export function serializeAlertEvent(e: AlertEventRow) {
  return {
    id: e.id,
    ruleId: e.rule_id,
    severity: e.severity,
    message: e.message,
    payload: safeJson(e.payload_json),
    createdAt: new Date(e.created_at).toISOString(),
    status: e.status,
    fingerprint: e.fingerprint,
    mutedUntil: e.muted_until
      ? new Date(e.muted_until).toISOString()
      : null,
    dismissedAt: e.dismissed_at
      ? new Date(e.dismissed_at).toISOString()
      : null,
    dismissedBy: e.dismissed_by,
    resolvedAt: e.resolved_at ? new Date(e.resolved_at).toISOString() : null,
  };
}

export type SerializedAlertEvent = ReturnType<typeof serializeAlertEvent>;

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
