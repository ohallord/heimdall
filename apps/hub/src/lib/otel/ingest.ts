import { asRecord, attrMap } from "./attrs";
import { getDb } from "@/lib/db/client";
import { getAgentById } from "@/lib/metrics/ingest";
import { maybePurgeOrgMetrics } from "@/lib/metrics/retention";
import { newId } from "@/lib/ids";

const MAX_POINTS = 500;

export type OtelPoint = {
  metricName: string;
  unit: string | null;
  value: number;
  collectedAt: Date;
  attributes: Record<string, string>;
  resourceService: string | null;
  resourceHost: string | null;
  agentId: string | null;
};

function numberFromPoint(dp: Record<string, unknown>): number | null {
  if (typeof dp.asDouble === "number" && Number.isFinite(dp.asDouble)) {
    return dp.asDouble;
  }
  if (typeof dp.asInt === "number" && Number.isFinite(dp.asInt)) return dp.asInt;
  if (typeof dp.asInt === "string" && dp.asInt.trim() !== "") {
    const n = Number(dp.asInt);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function timeFromPoint(dp: Record<string, unknown>, fallback: Date): Date {
  const raw = dp.timeUnixNano ?? dp.startTimeUnixNano;
  if (typeof raw === "string" || typeof raw === "number") {
    const nano = Number(raw);
    if (Number.isFinite(nano) && nano > 0) {
      return new Date(Math.floor(nano / 1e6));
    }
  }
  return fallback;
}

function percentFromUtilization(value: number): number {
  if (value >= 0 && value <= 1) return value * 100;
  return value;
}

/** Parse OTLP ExportMetricsServiceRequest JSON into flat points. */
export function parseOtlpMetricsJson(body: unknown): OtelPoint[] {
  const root = asRecord(body) ?? {};
  const resourceMetrics = Array.isArray(root.resourceMetrics)
    ? root.resourceMetrics
    : [];
  const now = new Date();
  const points: OtelPoint[] = [];

  for (const rm of resourceMetrics) {
    const rmRec = asRecord(rm);
    if (!rmRec) continue;
    const resource = asRecord(rmRec.resource);
    const resourceAttrs = attrMap(resource?.attributes);
    const resourceService = resourceAttrs["service.name"] ?? null;
    const resourceHost = resourceAttrs["host.name"] ?? null;
    const agentId = resourceAttrs["heimdall.agent_id"] ?? null;

    const scopeMetrics = Array.isArray(rmRec.scopeMetrics)
      ? rmRec.scopeMetrics
      : [];
    for (const sm of scopeMetrics) {
      const smRec = asRecord(sm);
      if (!smRec) continue;
      const metrics = Array.isArray(smRec.metrics) ? smRec.metrics : [];
      for (const metric of metrics) {
        const m = asRecord(metric);
        if (!m || typeof m.name !== "string") continue;
        const unit = typeof m.unit === "string" ? m.unit : null;
        const gauge = asRecord(m.gauge);
        const sum = asRecord(m.sum);
        const dataPoints = Array.isArray(gauge?.dataPoints)
          ? gauge!.dataPoints
          : Array.isArray(sum?.dataPoints)
            ? sum!.dataPoints
            : [];

        for (const dpRaw of dataPoints) {
          if (points.length >= MAX_POINTS) return points;
          const dp = asRecord(dpRaw);
          if (!dp) continue;
          const value = numberFromPoint(dp);
          if (value == null) continue;
          const pointAttrs = attrMap(dp.attributes);
          points.push({
            metricName: m.name,
            unit,
            value,
            collectedAt: timeFromPoint(dp, now),
            attributes: pointAttrs,
            resourceService,
            resourceHost,
            agentId,
          });
        }
      }
    }
  }

  return points;
}

async function mirrorHostMetrics(
  orgId: string,
  points: OtelPoint[],
): Promise<number> {
  const byAgent = new Map<
    string,
    { cpu?: number; mem?: number; collectedAt: Date }
  >();

  for (const p of points) {
    if (!p.agentId) continue;
    const name = p.metricName;
    let bucket = byAgent.get(p.agentId);
    if (!bucket) {
      bucket = { collectedAt: p.collectedAt };
      byAgent.set(p.agentId, bucket);
    }
    if (p.collectedAt > bucket.collectedAt) bucket.collectedAt = p.collectedAt;
    if (
      name === "system.cpu.utilization" ||
      name === "system.cpu.utilization_ratio"
    ) {
      bucket.cpu = percentFromUtilization(p.value);
    } else if (name === "system.memory.utilization") {
      bucket.mem = percentFromUtilization(p.value);
    }
  }

  const db = await getDb();
  let mirrored = 0;
  for (const [agentId, vals] of byAgent) {
    if (vals.cpu == null && vals.mem == null) continue;
    const agent = await getAgentById(agentId);
    if (!agent || agent.org_id !== orgId) continue;

    const existing = await db.query<{
      cpu_percent: number;
      mem_percent: number;
      mem_used_bytes: number;
      mem_total_bytes: number;
      load1: number;
      load5: number;
      load15: number;
      disks_json: string;
      mounts_json: string;
    }>(`SELECT * FROM agent_metric_latest WHERE agent_id = $1`, [agentId]);
    const prev = existing.rows[0];
    const cpu = vals.cpu ?? prev?.cpu_percent ?? 0;
    const mem = vals.mem ?? prev?.mem_percent ?? 0;
    const collectedAt = vals.collectedAt.toISOString();
    const sampleId = newId("ams");

    await db.query(
      `INSERT INTO agent_metric_samples (
         id, agent_id, org_id, collected_at,
         cpu_percent, mem_percent, mem_used_bytes, mem_total_bytes,
         load1, load5, load15, disks_json, mounts_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        sampleId,
        agentId,
        orgId,
        collectedAt,
        cpu,
        mem,
        prev?.mem_used_bytes ?? 0,
        prev?.mem_total_bytes ?? 0,
        prev?.load1 ?? 0,
        prev?.load5 ?? 0,
        prev?.load15 ?? 0,
        prev?.disks_json ?? "[]",
        prev?.mounts_json ?? "[]",
      ],
    );

    await db.query(
      `INSERT INTO agent_metric_latest (
         agent_id, org_id, collected_at,
         cpu_percent, mem_percent, mem_used_bytes, mem_total_bytes,
         load1, load5, load15, disks_json, mounts_json, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         collected_at = EXCLUDED.collected_at,
         cpu_percent = EXCLUDED.cpu_percent,
         mem_percent = EXCLUDED.mem_percent,
         mem_used_bytes = EXCLUDED.mem_used_bytes,
         mem_total_bytes = EXCLUDED.mem_total_bytes,
         load1 = EXCLUDED.load1,
         load5 = EXCLUDED.load5,
         load15 = EXCLUDED.load15,
         disks_json = EXCLUDED.disks_json,
         mounts_json = EXCLUDED.mounts_json,
         updated_at = NOW()`,
      [
        agentId,
        orgId,
        collectedAt,
        cpu,
        mem,
        prev?.mem_used_bytes ?? 0,
        prev?.mem_total_bytes ?? 0,
        prev?.load1 ?? 0,
        prev?.load5 ?? 0,
        prev?.load15 ?? 0,
        prev?.disks_json ?? "[]",
        prev?.mounts_json ?? "[]",
      ],
    );
    mirrored += 1;
  }
  return mirrored;
}

export async function ingestOtlpMetrics(input: {
  orgId: string;
  body: unknown;
}): Promise<{ accepted: number; mirroredHosts: number }> {
  const points = parseOtlpMetricsJson(input.body);
  if (points.length === 0) {
    return { accepted: 0, mirroredHosts: 0 };
  }

  const db = await getDb();
  for (const p of points) {
    let agentId = p.agentId;
    if (agentId) {
      const agent = await getAgentById(agentId);
      if (!agent || agent.org_id !== input.orgId) agentId = null;
    }
    await db.query(
      `INSERT INTO otel_metric_samples (
         id, org_id, resource_service, resource_host, agent_id,
         metric_name, unit, attributes_json, value, collected_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        newId("oms"),
        input.orgId,
        p.resourceService,
        p.resourceHost,
        agentId,
        p.metricName,
        p.unit,
        JSON.stringify(p.attributes),
        p.value,
        p.collectedAt.toISOString(),
      ],
    );
  }

  const mirroredHosts = await mirrorHostMetrics(input.orgId, points);
  void maybePurgeOrgMetrics(input.orgId);
  void maybePurgeOtelMetrics(input.orgId);

  return { accepted: points.length, mirroredHosts };
}

async function maybePurgeOtelMetrics(orgId: string): Promise<void> {
  await purgeOtelMetrics(orgId);
}

export async function purgeOtelMetrics(
  orgId: string,
  now = Date.now(),
): Promise<void> {
  // Reuse metrics retention days; delete old OTEL rows.
  const { getMetricsRetentionDays } = await import("@/lib/metrics/retention");
  const days = await getMetricsRetentionDays(orgId);
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();
  await db.query(
    `DELETE FROM otel_metric_samples WHERE org_id = $1 AND collected_at < $2`,
    [orgId, cutoff],
  );
}

export async function listOtelMetricSamples(
  orgId: string,
  opts?: { metricName?: string; limit?: number },
): Promise<
  Array<{
    id: string;
    metric_name: string;
    value: number;
    resource_service: string | null;
    resource_host: string | null;
    agent_id: string | null;
    collected_at: string;
  }>
> {
  const db = await getDb();
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  if (opts?.metricName) {
    const result = await db.query(
      `SELECT id, metric_name, value, resource_service, resource_host, agent_id, collected_at
       FROM otel_metric_samples
       WHERE org_id = $1 AND metric_name = $2
       ORDER BY collected_at DESC
       LIMIT $3`,
      [orgId, opts.metricName, limit],
    );
    return result.rows as Array<{
      id: string;
      metric_name: string;
      value: number;
      resource_service: string | null;
      resource_host: string | null;
      agent_id: string | null;
      collected_at: string;
    }>;
  }
  const result = await db.query(
    `SELECT id, metric_name, value, resource_service, resource_host, agent_id, collected_at
     FROM otel_metric_samples
     WHERE org_id = $1
     ORDER BY collected_at DESC
     LIMIT $2`,
    [orgId, limit],
  );
  return result.rows as Array<{
    id: string;
    metric_name: string;
    value: number;
    resource_service: string | null;
    resource_host: string | null;
    agent_id: string | null;
    collected_at: string;
  }>;
}
