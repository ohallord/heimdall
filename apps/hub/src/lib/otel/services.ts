import { getDb } from "@/lib/db/client";

export const SERVICES_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DETAIL_POINT_LIMIT = 200;
const SPARKLINE_POINTS = 48;

const RATE_METRICS = [
  "http.server.request.rate",
  "http.server.requests_per_second",
  "rpc.server.request.rate",
] as const;

const ERROR_METRICS = [
  "http.server.request.errors",
  "http.server.error.rate",
  "rpc.server.error.rate",
] as const;

const DURATION_METRICS = [
  "http.server.request.duration",
  "http.server.duration",
  "rpc.server.duration",
] as const;

export type ServiceRedSignals = {
  rate: number | null;
  /** True when rate is sample-count activity proxy, not a named rate metric. */
  rateIsActivity: boolean;
  errors: number | null;
  duration: number | null;
  durationUnit: string | null;
};

export type ServiceSummary = {
  service: string;
  lastSeen: string;
  sampleCount: number;
  metricCount: number;
  signals: ServiceRedSignals;
};

export type ServiceMetricSeries = {
  metricName: string;
  unit: string | null;
  latestValue: number;
  values: number[];
};

export type ServiceDetail = {
  service: string;
  lastSeen: string | null;
  sampleCount: number;
  signals: ServiceRedSignals;
  series: ServiceMetricSeries[];
  recent: Array<{
    id: string;
    metric_name: string;
    value: number;
    unit: string | null;
    resource_host: string | null;
    collected_at: string;
  }>;
};

function lookbackCutoff(lookbackMs = SERVICES_LOOKBACK_MS): string {
  return new Date(Date.now() - lookbackMs).toISOString();
}

function isHttpOrRpcMetric(name: string): boolean {
  return (
    name.startsWith("http.server.") ||
    name.startsWith("rpc.server.") ||
    name.startsWith("http.client.") ||
    name.startsWith("rpc.client.")
  );
}

function parseStatusCode(attributesJson: string): number | null {
  try {
    const attrs = JSON.parse(attributesJson) as Record<string, unknown>;
    const raw =
      attrs["http.response.status_code"] ??
      attrs["http.status_code"] ??
      attrs["rpc.grpc.status_code"];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

type SampleRow = {
  id: string;
  metric_name: string;
  unit: string | null;
  value: number;
  attributes_json: string;
  resource_host: string | null;
  collected_at: string;
};

function pickLatest(
  rows: SampleRow[],
  candidates: readonly string[],
): { value: number; unit: string | null } | null {
  const set = new Set(candidates);
  for (const row of rows) {
    if (set.has(row.metric_name)) {
      return { value: Number(row.value), unit: row.unit };
    }
  }
  return null;
}

/** Pure helper for tests: derive RED from newest-first sample rows. */
export function deriveRedSignals(rowsNewestFirst: SampleRow[]): ServiceRedSignals {
  const rateHit = pickLatest(rowsNewestFirst, RATE_METRICS);
  const errorHit = pickLatest(rowsNewestFirst, ERROR_METRICS);
  const durationHit = pickLatest(rowsNewestFirst, DURATION_METRICS);

  let rate: number | null = rateHit?.value ?? null;
  let rateIsActivity = false;
  if (rate == null) {
    const activity = rowsNewestFirst.filter((r) =>
      isHttpOrRpcMetric(r.metric_name),
    ).length;
    if (activity > 0) {
      rate = activity;
      rateIsActivity = true;
    }
  }

  let errors: number | null = errorHit?.value ?? null;
  if (errors == null) {
    let errCount = 0;
    for (const row of rowsNewestFirst) {
      if (!isHttpOrRpcMetric(row.metric_name)) continue;
      const code = parseStatusCode(row.attributes_json);
      if (code != null && code >= 500) errCount += 1;
    }
    if (errCount > 0) errors = errCount;
  }

  return {
    rate,
    rateIsActivity,
    errors,
    duration: durationHit?.value ?? null,
    durationUnit: durationHit?.unit ?? null,
  };
}

export async function listServices(
  orgId: string,
  opts?: { lookbackMs?: number },
): Promise<ServiceSummary[]> {
  const cutoff = lookbackCutoff(opts?.lookbackMs);
  const db = await getDb();
  const grouped = await db.query<{
    service: string;
    last_seen: string;
    sample_count: string;
    metric_count: string;
  }>(
    `SELECT resource_service AS service,
            MAX(collected_at) AS last_seen,
            COUNT(*)::text AS sample_count,
            COUNT(DISTINCT metric_name)::text AS metric_count
     FROM otel_metric_samples
     WHERE org_id = $1
       AND resource_service IS NOT NULL
       AND resource_service <> ''
       AND collected_at >= $2
     GROUP BY resource_service
     ORDER BY MAX(collected_at) DESC`,
    [orgId, cutoff],
  );

  const out: ServiceSummary[] = [];
  for (const row of grouped.rows) {
    const samples = await db.query<SampleRow>(
      `SELECT id, metric_name, unit, value, attributes_json, resource_host, collected_at
       FROM otel_metric_samples
       WHERE org_id = $1
         AND resource_service = $2
         AND collected_at >= $3
       ORDER BY collected_at DESC
       LIMIT $4`,
      [orgId, row.service, cutoff, DETAIL_POINT_LIMIT],
    );
    out.push({
      service: row.service,
      lastSeen: row.last_seen,
      sampleCount: Number(row.sample_count),
      metricCount: Number(row.metric_count),
      signals: deriveRedSignals(samples.rows),
    });
  }
  return out;
}

export async function getServiceDetail(
  orgId: string,
  service: string,
  opts?: { lookbackMs?: number },
): Promise<ServiceDetail> {
  const cutoff = lookbackCutoff(opts?.lookbackMs);
  const db = await getDb();
  const result = await db.query<SampleRow>(
    `SELECT id, metric_name, unit, value, attributes_json, resource_host, collected_at
     FROM otel_metric_samples
     WHERE org_id = $1
       AND resource_service = $2
       AND collected_at >= $3
     ORDER BY collected_at DESC
     LIMIT $4`,
    [orgId, service, cutoff, DETAIL_POINT_LIMIT],
  );
  const rows = result.rows;
  const signals = deriveRedSignals(rows);

  const byMetric = new Map<
    string,
    { unit: string | null; valuesOldestFirst: number[] }
  >();
  // rows are newest-first; build oldest-first for sparklines
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    let bucket = byMetric.get(row.metric_name);
    if (!bucket) {
      bucket = { unit: row.unit, valuesOldestFirst: [] };
      byMetric.set(row.metric_name, bucket);
    }
    bucket.valuesOldestFirst.push(Number(row.value));
    if (row.unit) bucket.unit = row.unit;
  }

  const preferred = [
    ...DURATION_METRICS,
    ...RATE_METRICS,
    ...ERROR_METRICS,
  ];
  const series: ServiceMetricSeries[] = [];
  const seen = new Set<string>();
  for (const name of preferred) {
    const bucket = byMetric.get(name);
    if (!bucket || seen.has(name)) continue;
    seen.add(name);
    const values = bucket.valuesOldestFirst.slice(-SPARKLINE_POINTS);
    series.push({
      metricName: name,
      unit: bucket.unit,
      latestValue: values[values.length - 1] ?? 0,
      values,
    });
  }
  for (const [name, bucket] of byMetric) {
    if (seen.has(name) || series.length >= 6) continue;
    if (!isHttpOrRpcMetric(name) && series.length >= 3) continue;
    seen.add(name);
    const values = bucket.valuesOldestFirst.slice(-SPARKLINE_POINTS);
    series.push({
      metricName: name,
      unit: bucket.unit,
      latestValue: values[values.length - 1] ?? 0,
      values,
    });
  }

  return {
    service,
    lastSeen: rows[0]?.collected_at ?? null,
    sampleCount: rows.length,
    signals,
    series,
    recent: rows.slice(0, 50).map((r) => ({
      id: r.id,
      metric_name: r.metric_name,
      value: Number(r.value),
      unit: r.unit,
      resource_host: r.resource_host,
      collected_at: r.collected_at,
    })),
  };
}

export function formatSignal(
  value: number | null,
  opts?: { unit?: string | null; activity?: boolean },
): string {
  if (value == null) return "—";
  if (opts?.activity) return `${Math.round(value)} pts`;
  const unit = opts?.unit?.trim();
  const n =
    Math.abs(value) >= 100
      ? value.toFixed(0)
      : Math.abs(value) >= 10
        ? value.toFixed(1)
        : value.toFixed(3);
  return unit ? `${n} ${unit}` : n;
}
