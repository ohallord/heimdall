/** Shared OTLP/JSON helpers (metrics, logs, traces). */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Flatten OTLP KeyValue[] scalar attributes into a string map. */
export function attrMap(attrs: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(attrs)) return out;
  for (const item of attrs) {
    const row = asRecord(item);
    if (!row || typeof row.key !== "string") continue;
    const v = asRecord(row.value);
    if (!v) continue;
    if (typeof v.stringValue === "string") out[row.key] = v.stringValue;
    else if (typeof v.intValue === "string" || typeof v.intValue === "number") {
      out[row.key] = String(v.intValue);
    } else if (typeof v.doubleValue === "number") {
      out[row.key] = String(v.doubleValue);
    } else if (typeof v.boolValue === "boolean") {
      out[row.key] = v.boolValue ? "true" : "false";
    }
  }
  return out;
}
