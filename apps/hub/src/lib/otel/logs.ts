import { asRecord, attrMap } from "./attrs";
import { getDb } from "@/lib/db/client";
import type { AgentRow } from "@/lib/db/types";
import {
  ingestLogLines,
  type LogIngestResult,
  type LogLineInput,
} from "@/lib/logs/ingest";

const MAX_RECORDS = 500;

export type OtelLogLine = LogLineInput & {
  agentId: string | null;
  hostname: string | null;
};

/**
 * Map bodies (OTLP kvlistValue), e.g. the journald receiver's whole journal entry, flattened to
 * scalar fields. Null when the body is not a map.
 */
function bodyMap(body: unknown): Record<string, string> | null {
  const kv = asRecord(asRecord(body)?.kvlistValue);
  return kv ? attrMap(kv.values) : null;
}

function bodyToLine(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === "string") return body;
  const rec = asRecord(body);
  if (!rec) {
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  if (typeof rec.stringValue === "string") return rec.stringValue;
  if (typeof rec.intValue === "string" || typeof rec.intValue === "number") {
    return String(rec.intValue);
  }
  if (typeof rec.doubleValue === "number") return String(rec.doubleValue);
  if (typeof rec.boolValue === "boolean") {
    return rec.boolValue ? "true" : "false";
  }
  if (rec.bytesValue != null) {
    try {
      return JSON.stringify(rec.bytesValue);
    } catch {
      return "[bytes]";
    }
  }
  try {
    return JSON.stringify(rec);
  } catch {
    return null;
  }
}

function timeFromRecord(rec: Record<string, unknown>, fallback: Date): Date {
  const raw = rec.timeUnixNano ?? rec.observedTimeUnixNano;
  if (typeof raw === "string" || typeof raw === "number") {
    const nano = Number(raw);
    if (Number.isFinite(nano) && nano > 0) {
      return new Date(Math.floor(nano / 1e6));
    }
  }
  return fallback;
}

function sourceFromAttrs(
  resourceAttrs: Record<string, string>,
  logAttrs: Record<string, string>,
  fields: Record<string, string> | null,
): string {
  return (
    logAttrs["_SYSTEMD_UNIT"] ||
    logAttrs["systemd.unit"] ||
    fields?.["_SYSTEMD_UNIT"] ||
    fields?.["SYSLOG_IDENTIFIER"] ||
    resourceAttrs["service.name"] ||
    logAttrs["log.file.path"] ||
    resourceAttrs["log.file.path"] ||
    "otel"
  );
}

/** Parse OTLP ExportLogsServiceRequest JSON into flat lines. */
export function parseOtlpLogsJson(body: unknown): OtelLogLine[] {
  const root = asRecord(body) ?? {};
  const resourceLogs = Array.isArray(root.resourceLogs)
    ? root.resourceLogs
    : [];
  const now = new Date();
  const lines: OtelLogLine[] = [];

  for (const rl of resourceLogs) {
    if (lines.length >= MAX_RECORDS) break;
    const rlRec = asRecord(rl);
    if (!rlRec) continue;
    const resource = asRecord(rlRec.resource);
    const resourceAttrs = attrMap(resource?.attributes);
    const agentId = resourceAttrs["heimdall.agent_id"] ?? null;
    const hostname =
      resourceAttrs["host.name"] ||
      resourceAttrs["service.name"] ||
      null;

    const scopeLogs = Array.isArray(rlRec.scopeLogs) ? rlRec.scopeLogs : [];
    for (const sl of scopeLogs) {
      if (lines.length >= MAX_RECORDS) break;
      const slRec = asRecord(sl);
      if (!slRec) continue;
      const logRecords = Array.isArray(slRec.logRecords)
        ? slRec.logRecords
        : [];
      for (const lr of logRecords) {
        if (lines.length >= MAX_RECORDS) break;
        const rec = asRecord(lr);
        if (!rec) continue;
        const logAttrs = attrMap(rec.attributes);
        const fields = bodyMap(rec.body);
        // A journald entry without MESSAGE (binary payload) has nothing worth showing; other
        // structured bodies keep their JSON form.
        const isJournal = fields != null && "__CURSOR" in fields;
        const line =
          fields?.["MESSAGE"] ?? (isJournal ? null : bodyToLine(rec.body));
        if (line == null || !line.trim()) continue;
        const observed = timeFromRecord(rec, now);
        lines.push({
          source: sourceFromAttrs(resourceAttrs, logAttrs, fields).slice(0, 512),
          line,
          observedAt: observed.toISOString(),
          agentId,
          hostname,
        });
      }
    }
  }

  return lines;
}

async function resolveAgentId(
  orgId: string,
  candidate: string | null,
): Promise<string | null> {
  if (!candidate) return null;
  const db = await getDb();
  const res = await db.query<AgentRow>(
    `SELECT id FROM agents WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [candidate, orgId],
  );
  return res.rows[0]?.id ?? null;
}

export async function ingestOtlpLogs(input: {
  orgId: string;
  body: unknown;
}): Promise<{ accepted: number; matches: number; alertsFired: number }> {
  const parsed = parseOtlpLogsJson(input.body);
  if (parsed.length === 0) {
    return { accepted: 0, matches: 0, alertsFired: 0 };
  }

  const agentCache = new Map<string, string | null>();
  async function cachedAgent(candidate: string | null) {
    if (!candidate) return null;
    if (agentCache.has(candidate)) return agentCache.get(candidate)!;
    const resolved = await resolveAgentId(input.orgId, candidate);
    agentCache.set(candidate, resolved);
    return resolved;
  }

  // Group by agentId + hostname so we can bind agents when present.
  const groups = new Map<
    string,
    { agentId: string | null; hostname: string; lines: LogLineInput[] }
  >();

  for (const row of parsed) {
    const resolvedAgent = await cachedAgent(row.agentId);
    const hostname = (row.hostname || "otel").slice(0, 256);
    const key = `${resolvedAgent ?? ""}|${hostname}`;
    let group = groups.get(key);
    if (!group) {
      group = { agentId: resolvedAgent, hostname, lines: [] };
      groups.set(key, group);
    }
    group.lines.push({
      source: row.source,
      line: row.line,
      observedAt: row.observedAt,
    });
  }

  let accepted = 0;
  let matches = 0;
  let alertsFired = 0;

  for (const group of groups.values()) {
    const result: LogIngestResult = await ingestLogLines({
      orgId: input.orgId,
      agentId: group.agentId,
      hostname: group.hostname,
      lines: group.lines,
      touchAgentLastSeen: Boolean(group.agentId),
    });
    if (!result.ok) continue;
    accepted += result.accepted;
    matches += result.matches;
    alertsFired += result.alertsFired;
  }

  return { accepted, matches, alertsFired };
}
