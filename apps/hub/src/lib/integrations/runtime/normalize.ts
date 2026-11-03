import type { NormalizedFinding } from "@/lib/security/types";
import { normalizeSeverity, type VulnSeverity } from "@/lib/security/types";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function strField(obj: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function outputFields(obj: JsonRecord): JsonRecord {
  const raw = obj.output_fields ?? obj.outputFields;
  return asRecord(raw) ?? {};
}

function fieldStr(fields: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = fields[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

/** Map Falco priority → finding severity. */
export function falcoPriorityToSeverity(raw: unknown): VulnSeverity {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (
    s === "emergency" ||
    s === "alert" ||
    s === "critical" ||
    s === "crit"
  ) {
    return "critical";
  }
  if (s === "error" || s === "err" || s === "high") return "high";
  if (s === "warning" || s === "warn" || s === "medium") return "medium";
  if (s === "notice" || s === "informational" || s === "info" || s === "low") {
    return "low";
  }
  if (s === "debug" || s === "") return "unknown";
  return normalizeSeverity(raw);
}

function resourceFromEvent(obj: JsonRecord, fields: JsonRecord): string {
  return (
    fieldStr(
      fields,
      "k8s.pod.name",
      "ka.target.name",
      "container.name",
      "proc.name",
    ) ||
    strField(obj, "hostname", "host") ||
    fieldStr(fields, "fd.name") ||
    "unknown"
  );
}

export function normalizeRuntimeEvent(raw: unknown): NormalizedFinding | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const fields = outputFields(obj);
  const rule =
    strField(obj, "rule", "Rule") ||
    strField(fields, "rule") ||
    "runtime-event";
  const output =
    strField(obj, "output", "message", "msg") ||
    rule;
  const priority = obj.priority ?? obj.Priority ?? obj.severity;
  const resource = resourceFromEvent(obj, fields);

  return {
    source: "runtime",
    externalId: rule.slice(0, 256),
    title: rule.slice(0, 512),
    severity: falcoPriorityToSeverity(priority),
    resource: resource.slice(0, 512),
    packageName: fieldStr(fields, "container.image.repository", "container.image"),
    url: undefined,
    raw: {
      output,
      priority,
      rule,
      output_fields: fields,
      hostname: strField(obj, "hostname", "host"),
      source: strField(obj, "source"),
      tags: obj.tags,
      time: obj.time ?? obj.Time,
      event: obj,
    },
  };
}

/** Accept single event, array, or `{ events: [...] }`. */
export function normalizeRuntimePayload(body: unknown): NormalizedFinding[] {
  if (Array.isArray(body)) {
    return body
      .map((item) => normalizeRuntimeEvent(item))
      .filter((f): f is NormalizedFinding => f != null);
  }
  const obj = asRecord(body);
  if (!obj) return [];
  if (Array.isArray(obj.events)) {
    return obj.events
      .map((item) => normalizeRuntimeEvent(item))
      .filter((f): f is NormalizedFinding => f != null);
  }
  const one = normalizeRuntimeEvent(obj);
  return one ? [one] : [];
}
