import { getDb } from "@/lib/db/client";
import { getMetricsRetentionDays } from "./retention";

export type HistoryMetric = "cpu" | "memory" | "disk";

export type HistoryPoint = { t: string; v: number };

export type MetricHistoryResult = {
  metric: HistoryMetric;
  mount: string | null;
  from: string;
  to: string;
  stepSeconds: number;
  retentionDays: number;
  points: HistoryPoint[];
};

const MS = 1000;

export function chooseStepSeconds(
  fromMs: number,
  toMs: number,
  maxPoints: number,
): number {
  const spanSec = Math.max(1, Math.ceil((toMs - fromMs) / MS));
  let step: number;
  if (spanSec <= 24 * 3600) step = 10;
  else if (spanSec <= 7 * 24 * 3600) step = 60;
  else step = 300;

  const needed = Math.ceil(spanSec / step);
  if (needed > maxPoints) {
    step = Math.ceil(spanSec / maxPoints);
    // Snap to friendly seconds
    if (step < 60) step = Math.max(10, Math.ceil(step / 10) * 10);
    else if (step < 300) step = Math.ceil(step / 60) * 60;
    else if (step < 3600) step = Math.ceil(step / 300) * 300;
    else step = Math.ceil(step / 3600) * 3600;
  }
  return step;
}

function extractDiskPercent(disksJson: string, mount: string): number | null {
  try {
    const disks = JSON.parse(disksJson) as Array<{
      mountPoint?: string;
      usedPercent?: number;
    }>;
    const hit = disks.find((d) => d.mountPoint === mount);
    if (!hit || !Number.isFinite(hit.usedPercent)) return null;
    return Number(hit.usedPercent);
  } catch {
    return null;
  }
}

function bucketAverage(
  samples: Array<{ tMs: number; v: number }>,
  stepSeconds: number,
): HistoryPoint[] {
  if (samples.length === 0) return [];
  const stepMs = stepSeconds * MS;
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    const key = Math.floor(s.tMs / stepMs) * stepMs;
    const cur = buckets.get(key) ?? { sum: 0, n: 0 };
    cur.sum += s.v;
    cur.n += 1;
    buckets.set(key, cur);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tMs, { sum, n }]) => ({
      t: new Date(tMs).toISOString(),
      v: sum / n,
    }));
}

export async function queryMetricHistory(input: {
  orgId: string;
  agentId: string;
  metric: HistoryMetric;
  from: Date;
  to: Date;
  mount?: string;
  maxPoints?: number;
}): Promise<MetricHistoryResult | { error: string; status: number }> {
  const maxPoints = Math.min(5000, Math.max(50, input.maxPoints ?? 2000));
  const retentionDays = await getMetricsRetentionDays(input.orgId);
  const retentionStart = Date.now() - retentionDays * 24 * 60 * 60 * MS;
  let fromMs = input.from.getTime();
  let toMs = input.to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { error: "invalid from/to", status: 400 };
  }
  if (fromMs >= toMs) {
    return { error: "from must be before to", status: 400 };
  }
  if (fromMs < retentionStart - 60_000) {
    return {
      error: `from is older than retention (${retentionDays}d)`,
      status: 400,
    };
  }
  fromMs = Math.max(fromMs, retentionStart);
  toMs = Math.min(toMs, Date.now());

  const mount = input.metric === "disk" ? (input.mount?.trim() || "/") : null;
  const stepSeconds = chooseStepSeconds(fromMs, toMs, maxPoints);
  const db = await getDb();

  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  let points: HistoryPoint[] = [];

  if (input.metric === "cpu" || input.metric === "memory") {
    const col = input.metric === "cpu" ? "cpu_percent" : "mem_percent";
    // Portable epoch bucketing (Postgres + PGlite).
    const result = await db.query<{ bucket_epoch: number; v: number }>(
      `SELECT
         (floor(extract(epoch from collected_at) / $4) * $4)::bigint AS bucket_epoch,
         avg(${col})::float8 AS v
       FROM agent_metric_samples
       WHERE agent_id = $1
         AND collected_at >= $2::timestamptz
         AND collected_at <= $3::timestamptz
       GROUP BY 1
       ORDER BY 1 ASC`,
      [input.agentId, fromIso, toIso, stepSeconds],
    );
    points = result.rows.map((r) => ({
      t: new Date(Number(r.bucket_epoch) * MS).toISOString(),
      v: Number(r.v),
    }));
  } else {
    const result = await db.query<{ collected_at: string; disks_json: string }>(
      `SELECT collected_at, disks_json
       FROM agent_metric_samples
       WHERE agent_id = $1
         AND collected_at >= $2::timestamptz
         AND collected_at <= $3::timestamptz
       ORDER BY collected_at ASC`,
      [input.agentId, fromIso, toIso],
    );
    const samples: Array<{ tMs: number; v: number }> = [];
    for (const row of result.rows) {
      const v = extractDiskPercent(row.disks_json, mount!);
      if (v == null) continue;
      samples.push({ tMs: new Date(row.collected_at).getTime(), v });
    }
    points = bucketAverage(samples, stepSeconds);
  }

  return {
    metric: input.metric,
    mount,
    from: fromIso,
    to: toIso,
    stepSeconds,
    retentionDays,
    points,
  };
}
