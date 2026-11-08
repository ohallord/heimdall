import { asRecord, attrMap } from "./attrs";
import { getDb } from "@/lib/db/client";
import { newId } from "@/lib/ids";
import { getTracesRetentionDays } from "@/lib/metrics/retention";

/** Spans beyond this per request are dropped and reported as rejectedSpans. */
export const MAX_SPANS_PER_REQUEST = 1000;
const INSERT_BATCH = 200;
const MAX_ATTR_VALUE = 1024;
const UNKNOWN_SERVICE = "unknown_service";

const KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"] as const;
const STATUSES = ["unset", "ok", "error"] as const;

export type OtelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  serviceName: string;
  name: string;
  kind: (typeof KINDS)[number];
  statusCode: (typeof STATUSES)[number];
  statusMessage: string | null;
  startAt: Date;
  durationMs: number;
  resourceHost: string | null;
  agentId: string | null;
  attributes: Record<string, string>;
};

/**
 * OTLP/JSON ids are hex per spec; some SDKs emit base64 (protobuf JSON
 * mapping). Normalise both to lowercase hex; anything else is invalid.
 */
function normaliseId(raw: unknown, bytes: number): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.length === bytes * 2 && /^[0-9a-f]+$/i.test(raw)) {
    const hex = raw.toLowerCase();
    return /^0+$/.test(hex) ? null : hex;
  }
  if (/^[A-Za-z0-9+/]+=*$/.test(raw)) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === bytes) {
      const hex = buf.toString("hex");
      return /^0+$/.test(hex) ? null : hex;
    }
  }
  return null;
}

function enumFrom<T extends string>(
  raw: unknown,
  values: readonly T[],
  prefix: string,
): T {
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return values[raw] ?? values[0];
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isInteger(n)) return values[n] ?? values[0];
    const name = raw.toLowerCase().replace(prefix, "") as T;
    if (values.includes(name)) return name;
  }
  return values[0];
}

function nanos(raw: unknown): bigint | null {
  try {
    if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return BigInt(Math.round(raw));
    }
  } catch {
    return null;
  }
  return null;
}

function capAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = v.length > MAX_ATTR_VALUE ? v.slice(0, MAX_ATTR_VALUE) : v;
  }
  return out;
}

/** Parse OTLP ExportTraceServiceRequest JSON into flat spans. */
export function parseOtlpTracesJson(body: unknown): {
  spans: OtelSpan[];
  dropped: number;
} {
  const root = asRecord(body) ?? {};
  const resourceSpans = Array.isArray(root.resourceSpans) ? root.resourceSpans : [];
  const spans: OtelSpan[] = [];
  let dropped = 0;

  for (const rs of resourceSpans) {
    const rsRec = asRecord(rs);
    if (!rsRec) continue;
    const resourceAttrs = attrMap(asRecord(rsRec.resource)?.attributes);
    const serviceName = (resourceAttrs["service.name"] || UNKNOWN_SERVICE).slice(0, 256);
    const resourceHost = resourceAttrs["host.name"]?.slice(0, 256) || null;
    const agentId = resourceAttrs["heimdall.agent_id"] || null;

    const scopeSpans = Array.isArray(rsRec.scopeSpans) ? rsRec.scopeSpans : [];
    for (const ss of scopeSpans) {
      const ssRec = asRecord(ss);
      const list = ssRec && Array.isArray(ssRec.spans) ? ssRec.spans : [];
      for (const raw of list) {
        const rec = asRecord(raw);
        if (!rec) continue;
        const traceId = normaliseId(rec.traceId, 16);
        const spanId = normaliseId(rec.spanId, 8);
        const start = nanos(rec.startTimeUnixNano);
        if (!traceId || !spanId || start == null) continue;
        if (spans.length >= MAX_SPANS_PER_REQUEST) {
          dropped += 1;
          continue;
        }
        const end = nanos(rec.endTimeUnixNano);
        const durNs = end != null && end > start ? end - start : BigInt(0);
        const status = asRecord(rec.status);
        spans.push({
          traceId,
          spanId,
          parentSpanId: normaliseId(rec.parentSpanId, 8),
          serviceName,
          name: (typeof rec.name === "string" && rec.name ? rec.name : "(unnamed)").slice(0, 512),
          kind: enumFrom(rec.kind, KINDS, "span_kind_"),
          statusCode: enumFrom(status?.code, STATUSES, "status_code_"),
          statusMessage:
            typeof status?.message === "string" && status.message
              ? status.message.slice(0, 1024)
              : null,
          startAt: new Date(Number(start / BigInt(1_000_000))),
          durationMs: Number(durNs) / 1e6,
          resourceHost,
          agentId,
          attributes: capAttrs(attrMap(rec.attributes)),
        });
      }
    }
  }
  return { spans, dropped };
}

async function resolveAgents(
  orgId: string,
  candidates: Set<string>,
): Promise<Set<string>> {
  if (candidates.size === 0) return new Set();
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE org_id = $1 AND id = ANY($2::text[])`,
    [orgId, [...candidates]],
  );
  return new Set(res.rows.map((r) => r.id));
}

export async function ingestOtlpTraces(input: {
  orgId: string;
  body: unknown;
}): Promise<{ accepted: number; rejected: number }> {
  const { spans, dropped } = parseOtlpTracesJson(input.body);
  if (spans.length === 0) return { accepted: 0, rejected: dropped };

  const known = await resolveAgents(
    input.orgId,
    new Set(spans.map((s) => s.agentId).filter((a): a is string => !!a)),
  );
  const db = await getDb();
  for (let i = 0; i < spans.length; i += INSERT_BATCH) {
    const batch = spans.slice(i, i + INSERT_BATCH);
    const params: unknown[] = [];
    const rows = batch.map((s) => {
      const base = params.length;
      params.push(
        newId("spn"),
        input.orgId,
        s.traceId,
        s.spanId,
        s.parentSpanId,
        s.serviceName,
        s.name,
        s.kind,
        s.statusCode,
        s.statusMessage,
        s.startAt.toISOString(),
        s.durationMs,
        s.resourceHost,
        s.agentId && known.has(s.agentId) ? s.agentId : null,
        JSON.stringify(s.attributes),
      );
      return `(${Array.from({ length: 15 }, (_, j) => `$${base + j + 1}`).join(",")})`;
    });
    await db.query(
      `INSERT INTO otel_spans (
         id, org_id, trace_id, span_id, parent_span_id, service_name, name,
         kind, status_code, status_message, start_at, duration_ms,
         resource_host, agent_id, attributes_json
       ) VALUES ${rows.join(",")}
       ON CONFLICT (org_id, trace_id, span_id) DO NOTHING`,
      params,
    );
  }
  return { accepted: spans.length, rejected: dropped };
}

export type SpanRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service_name: string;
  name: string;
  kind: string;
  status_code: string;
  status_message: string | null;
  start_at: string;
  duration_ms: number;
  resource_host: string | null;
  agent_id: string | null;
  attributes: Record<string, string>;
};

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** All spans of one trace, in start order (Phase 30 waterfall). */
export async function getTrace(orgId: string, traceId: string): Promise<SpanRow[]> {
  const db = await getDb();
  const res = await db.query<Record<string, unknown>>(
    `SELECT trace_id, span_id, parent_span_id, service_name, name, kind,
            status_code, status_message, start_at, duration_ms, resource_host,
            agent_id, attributes_json
     FROM otel_spans
     WHERE org_id = $1 AND trace_id = $2
     ORDER BY start_at ASC, span_id ASC
     LIMIT 5000`,
    [orgId, traceId.toLowerCase()],
  );
  return res.rows.map((r) => {
    let attributes: Record<string, string> = {};
    try {
      attributes = JSON.parse(String(r.attributes_json ?? "{}"));
    } catch {
      attributes = {};
    }
    return {
      trace_id: String(r.trace_id),
      span_id: String(r.span_id),
      parent_span_id: (r.parent_span_id as string | null) ?? null,
      service_name: String(r.service_name),
      name: String(r.name),
      kind: String(r.kind),
      status_code: String(r.status_code),
      status_message: (r.status_message as string | null) ?? null,
      start_at: iso(r.start_at),
      duration_ms: Number(r.duration_ms),
      resource_host: (r.resource_host as string | null) ?? null,
      agent_id: (r.agent_id as string | null) ?? null,
      attributes,
    };
  });
}

export type TraceSummary = {
  trace_id: string;
  started_at: string;
  duration_ms: number;
  span_count: number;
  error_count: number;
  root_name: string;
  root_service: string;
};

/** Most recent traces (by first span start), optionally containing a service. */
export async function listRecentTraces(
  orgId: string,
  opts?: {
    service?: string;
    limit?: number;
    since?: Date;
    /** Only traces with at least one error span. */
    errorsOnly?: boolean;
    /** Only traces at least this long (end-to-end). */
    minDurationMs?: number;
    /** Only traces with an entry span of this name (in `service`, if set). */
    operation?: string;
  },
): Promise<TraceSummary[]> {
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 50));
  const db = await getDb();
  const res = await db.query<Record<string, unknown>>(
    `WITH t AS (
       SELECT trace_id,
              MIN(start_at) AS started_at,
              COUNT(*)::int AS span_count,
              SUM(CASE WHEN status_code = 'error' THEN 1 ELSE 0 END)::int AS error_count,
              (MAX(EXTRACT(EPOCH FROM start_at)::float8 * 1000 + duration_ms)
                 - MIN(EXTRACT(EPOCH FROM start_at)::float8 * 1000)) AS duration_ms
       FROM otel_spans
       WHERE org_id = $1 AND ($3::timestamptz IS NULL OR start_at >= $3::timestamptz)
       GROUP BY trace_id
       HAVING ($2::text IS NULL OR bool_or(service_name = $2::text))
          AND (NOT $5::boolean OR bool_or(status_code = 'error'))
          AND ($6::float8 IS NULL
               OR (MAX(EXTRACT(EPOCH FROM start_at)::float8 * 1000 + duration_ms)
                   - MIN(EXTRACT(EPOCH FROM start_at)::float8 * 1000)) >= $6::float8)
          AND ($7::text IS NULL OR bool_or(
                name = $7::text
                AND ($2::text IS NULL OR service_name = $2::text)
                AND ${ENTRY_SQL}))
       ORDER BY started_at DESC
       LIMIT $4
     )
     SELECT t.*, r.name AS root_name, r.service_name AS root_service
     FROM t
     LEFT JOIN LATERAL (
       SELECT s.name, s.service_name FROM otel_spans s
       WHERE s.org_id = $1 AND s.trace_id = t.trace_id
       ORDER BY (s.parent_span_id IS NULL) DESC, s.start_at ASC
       LIMIT 1
     ) r ON TRUE
     ORDER BY t.started_at DESC`,
    [
      orgId,
      opts?.service ?? null,
      opts?.since?.toISOString() ?? null,
      limit,
      opts?.errorsOnly ?? false,
      opts?.minDurationMs ?? null,
      opts?.operation ?? null,
    ],
  );
  return res.rows.map((r) => ({
    trace_id: String(r.trace_id),
    started_at: iso(r.started_at),
    duration_ms: Number(r.duration_ms),
    span_count: Number(r.span_count),
    error_count: Number(r.error_count),
    root_name: String(r.root_name ?? ""),
    root_service: String(r.root_service ?? ""),
  }));
}

/** Delete spans older than the org's traces retention. Returns rows removed. */
export async function purgeOtelSpans(orgId: string, now = Date.now()): Promise<number> {
  const days = await getTracesRetentionDays(orgId);
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();
  const res = await db.query(
    `DELETE FROM otel_spans WHERE org_id = $1 AND start_at < $2 RETURNING id`,
    [orgId, cutoff],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Phase 30: APM UI helpers
// ---------------------------------------------------------------------------

/**
 * Entry spans: where a request enters a service. RED stats use only these,
 * so client/internal child spans do not double-count a request.
 */
const ENTRY_SQL = `(kind IN ('server', 'consumer') OR parent_span_id IS NULL)`;

export const TRACE_WINDOWS = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
} as const;
export type TraceWindowKey = keyof typeof TRACE_WINDOWS;
export const DEFAULT_TRACE_WINDOW: TraceWindowKey = "1h";

export function parseWindow(raw: string | string[] | undefined): {
  key: TraceWindowKey;
  ms: number;
} {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const key = v && v in TRACE_WINDOWS ? (v as TraceWindowKey) : DEFAULT_TRACE_WINDOW;
  return { key, ms: TRACE_WINDOWS[key] };
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export type RedStats = {
  count: number;
  ratePerMin: number;
  errorPct: number;
  p50Ms: number;
  p95Ms: number;
  lastSeen: string;
};

async function redBy(
  column: "service_name" | "name",
  orgId: string,
  since: Date,
  now: Date,
  service?: string,
): Promise<Array<RedStats & { key: string }>> {
  const db = await getDb();
  const res = await db.query<Record<string, unknown>>(
    `SELECT ${column} AS key,
            COUNT(*)::int AS count,
            SUM(CASE WHEN status_code = 'error' THEN 1 ELSE 0 END)::int AS errors,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
            MAX(start_at) AS last_seen
     FROM otel_spans
     WHERE org_id = $1 AND start_at >= $2 AND start_at <= $3
       AND ($4::text IS NULL OR service_name = $4::text)
       AND ${ENTRY_SQL}
     GROUP BY ${column}
     ORDER BY count DESC, key ASC
     LIMIT 200`,
    [orgId, since.toISOString(), now.toISOString(), service ?? null],
  );
  const minutes = Math.max(1 / 60, (now.getTime() - since.getTime()) / 60_000);
  return res.rows.map((r) => {
    const count = Number(r.count);
    return {
      key: String(r.key),
      count,
      ratePerMin: count / minutes,
      errorPct: count ? (Number(r.errors) / count) * 100 : 0,
      p50Ms: Number(r.p50),
      p95Ms: Number(r.p95),
      lastSeen: iso(r.last_seen),
    };
  });
}

export type TraceServiceStats = RedStats & { service: string };

/** Span-derived RED per service over [since, now]. Busiest first. */
export async function listTraceServices(
  orgId: string,
  opts: { since: Date; now?: Date; service?: string },
): Promise<TraceServiceStats[]> {
  const rows = await redBy(
    "service_name",
    orgId,
    opts.since,
    opts.now ?? new Date(),
    opts.service,
  );
  return rows.map(({ key, ...rest }) => ({ service: key, ...rest }));
}

export type OperationStats = RedStats & { name: string };

/** Span-derived RED per entry-span name for one service. Busiest first. */
export async function listOperations(
  orgId: string,
  service: string,
  opts: { since: Date; now?: Date },
): Promise<OperationStats[]> {
  const rows = await redBy("name", orgId, opts.since, opts.now ?? new Date(), service);
  return rows.map(({ key, ...rest }) => ({ name: key, ...rest }));
}

export type WaterfallRow = {
  span: SpanRow;
  depth: number;
  /** Bar start, % of trace duration. */
  offsetPct: number;
  /** Bar width, % of trace duration (min 0.5 so tiny spans stay visible). */
  widthPct: number;
  /** Parent span id set but not present in this trace. */
  orphan: boolean;
};

const MIN_BAR_PCT = 0.5;

/** Depth-first span tree (children by start time) with bar geometry. */
export function buildWaterfall(spans: SpanRow[]): WaterfallRow[] {
  if (spans.length === 0) return [];
  const startOf = (s: SpanRow) => Date.parse(s.start_at);
  const byStart = [...spans].sort(
    (a, b) => startOf(a) - startOf(b) || a.span_id.localeCompare(b.span_id),
  );
  const t0 = Math.min(...byStart.map(startOf));
  const t1 = Math.max(...byStart.map((s) => startOf(s) + s.duration_ms));
  const total = t1 - t0;

  const ids = new Set(byStart.map((s) => s.span_id));
  const children = new Map<string, SpanRow[]>();
  const roots: SpanRow[] = [];
  for (const s of byStart) {
    if (s.parent_span_id && ids.has(s.parent_span_id) && s.parent_span_id !== s.span_id) {
      const list = children.get(s.parent_span_id) ?? [];
      list.push(s);
      children.set(s.parent_span_id, list);
    } else {
      roots.push(s);
    }
  }

  const out: WaterfallRow[] = [];
  const seen = new Set<string>();
  const visit = (s: SpanRow, depth: number) => {
    if (seen.has(s.span_id)) return; // guard against cycles in bad data
    seen.add(s.span_id);
    let offsetPct = 0;
    let widthPct = 100;
    if (total > 0) {
      offsetPct = ((startOf(s) - t0) / total) * 100;
      widthPct = Math.max(MIN_BAR_PCT, (s.duration_ms / total) * 100);
      if (offsetPct + widthPct > 100) offsetPct = Math.max(0, 100 - widthPct);
    }
    out.push({
      span: s,
      depth,
      offsetPct,
      widthPct,
      orphan: depth === 0 && !!s.parent_span_id,
    });
    for (const c of children.get(s.span_id) ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  // Spans only reachable through a cycle: render flat rather than drop.
  for (const s of byStart) if (!seen.has(s.span_id)) visit(s, 0);
  return out;
}

export function formatRate(perMin: number): string {
  if (perMin >= 100) return `${Math.round(perMin)}/min`;
  if (perMin >= 1) return `${perMin.toFixed(1)}/min`;
  return `${perMin.toFixed(2)}/min`;
}
