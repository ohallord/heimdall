import {
  alertCooldownKey,
  shouldFireAlert,
} from "@/lib/alerts/cooldown";
import { hostBandDefaultsForMetric } from "@/lib/alerts/bands";
import {
  effectiveAlarm,
  effectiveWarn,
  evaluateRule,
  evaluateRuleBand,
  ruleMatchesMetric,
  type ThresholdSample,
} from "@/lib/alerts/engine";
import { alertFingerprint } from "@/lib/alerts/fingerprint";
import {
  alertDeepLink,
  formatMetricValue,
  formatThreshold,
  formatTimestamp,
  metricLabel,
} from "@/lib/alerts/format";
import { buildRecoveryPayloads } from "@/lib/alerts/recovery";
import { areAlertsPaused } from "@/lib/alerts/pause";
import { enqueueAlert } from "@/lib/alerts/queue";
import { getDb } from "@/lib/db/client";
import type {
  AgentRow,
  ContainerMetric,
  ContainersLatestRow,
  DiskMetric,
  K8sClusterMetric,
  K8sLatestRow,
  MetricLatestRow,
  MetricSampleRow,
  MountMetric,
} from "@/lib/db/types";
import {
  ensureCluster,
  ensureDefaultThresholdRule,
  insertAlertEvent,
  resolveRecoveredAlerts,
  isFingerprintMuted,
  listAlertChannels,
  listAlertRules,
  listNotificationPrefs,
} from "@/lib/db/store";
import { newId } from "@/lib/ids";
import { maybePurgeOrgMetrics } from "@/lib/metrics/retention";

export type MetricsIngestInput = {
  agentId: string;
  clusterId?: string;
  collectedAt?: string;
  cpuPercent: number;
  memPercent: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  disks?: DiskMetric[];
  mounts?: MountMetric[];
  containerRuntime?: string;
  containers?: ContainerMetric[];
  kubernetes?: K8sClusterMetric | null;
};

export type MetricsIngestResult =
  | {
      ok: true;
      agent: AgentRow;
      sampleId: string;
      alertsFired: number;
      lastSeenAt: string;
    }
  | { ok: false; error: string; status: number };

const ONLINE_WINDOW_MS = 45_000;

export function isAgentOnline(lastSeenAt: string | Date, now = Date.now()): boolean {
  const ts = new Date(lastSeenAt).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts <= ONLINE_WINDOW_MS;
}

export function samplesFromMetrics(input: MetricsIngestInput): ThresholdSample[] {
  const samples: ThresholdSample[] = [
    { metric: "cpu_percent", value: input.cpuPercent },
    { metric: "mem_percent", value: input.memPercent },
  ];

  for (const disk of input.disks ?? []) {
    if (!Number.isFinite(disk.usedPercent)) continue;
    if (disk.mountPoint === "/") {
      samples.push({ metric: "disk_percent", value: disk.usedPercent });
    } else {
      samples.push({
        metric: `disk_percent:${disk.mountPoint}`,
        value: disk.usedPercent,
      });
    }
  }

  for (const mount of input.mounts ?? []) {
    if (!mount.present) {
      samples.push({ metric: "mount_missing", value: 1 });
      samples.push({ metric: `mount_missing:${mount.path}`, value: 1 });
    }
  }

  samples.push(...samplesFromContainers(input.containers ?? []));
  if (input.kubernetes) {
    samples.push(...samplesFromKubernetes(input.kubernetes));
  }
  return samples;
}

export function samplesFromContainers(
  containers: ContainerMetric[],
): ThresholdSample[] {
  const samples: ThresholdSample[] = [];
  for (const c of containers) {
    const state = (c.state || "").toLowerCase();
    // Only containers the hub saw stop abnormally (see markContainerExitAlerts);
    // long-stopped or cleanly stopped containers are not an incident.
    if (isStopped(state) && c.exitAlert) {
      samples.push({ metric: `container_exited:${containerKey(c)}`, value: 1 });
    }
    if (c.oomKilled) {
      samples.push({ metric: "container_oom", value: 1 });
    }
    if (c.restartLoop || state === "restarting" || (c.restartCount ?? 0) >= 3) {
      samples.push({ metric: "container_restart_loop", value: 1 });
    }
    if (c.memPercent != null && Number.isFinite(c.memPercent)) {
      samples.push({ metric: "container_mem_limit_pct", value: c.memPercent });
    }
    if (c.cpuPercent != null && Number.isFinite(c.cpuPercent)) {
      samples.push({ metric: "container_cpu_pct", value: c.cpuPercent });
    }
  }
  return samples;
}

function isStopped(state: string | undefined): boolean {
  const s = (state || "").toLowerCase();
  return s === "exited" || s === "dead";
}

function containerKey(c: Pick<ContainerMetric, "name" | "id">): string {
  return c.name?.trim() || c.id;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  // Docker reports "0001-01-01T00:00:00Z" for containers that never stopped.
  return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * Decide which stopped containers are an incident worth alerting on, and
 * carry that decision forward so the alert stays open while they stay down.
 *
 * A stopped container alerts when it exited with a non-zero code (or is dead)
 * AND either:
 *  - the previous snapshot already flagged it (still down), or
 *  - the previous snapshot saw it not stopped (running → exited), or
 *  - it finished after the previous snapshot (crashed between scrapes).
 * Containers already stopped when first seen, or that exited 0, are ignored.
 * With no previous snapshot (new agent) nothing alerts.
 */
export function markContainerExitAlerts(
  current: ContainerMetric[],
  previous: { containers: ContainerMetric[]; collectedAt: string } | null,
): ContainerMetric[] {
  const prevByKey = new Map(
    (previous?.containers ?? []).map((c) => [containerKey(c), c]),
  );
  const prevAt = parseTime(previous?.collectedAt);
  return current.map((c) => {
    // Never trust an agent-sent flag; the hub owns it.
    const rest: ContainerMetric = { ...c };
    delete rest.exitAlert;
    if (!previous || !isStopped(c.state)) return rest;
    const dead = (c.state || "").toLowerCase() === "dead";
    const abnormal = dead || (c.exitCode ?? 1) !== 0;
    if (!abnormal) return rest;
    const prev = prevByKey.get(containerKey(c));
    const finishedAt = parseTime(c.finishedAt);
    const flag =
      prev?.exitAlert === true ||
      (prev != null && !isStopped(prev.state)) ||
      (prevAt != null && finishedAt != null && finishedAt > prevAt);
    return flag ? { ...rest, exitAlert: true } : rest;
  });
}

async function loadPreviousContainers(
  agentId: string,
): Promise<{ containers: ContainerMetric[]; collectedAt: string } | null> {
  const row = await getLatestContainers(agentId);
  if (!row) return null;
  try {
    const containers = JSON.parse(row.containers_json) as ContainerMetric[];
    if (!Array.isArray(containers)) return null;
    return { containers, collectedAt: new Date(row.collected_at).toISOString() };
  } catch {
    return null;
  }
}

export function samplesFromKubernetes(k8s: K8sClusterMetric): ThresholdSample[] {
  const samples: ThresholdSample[] = [];
  // Collection off — do not alert as if the API were down.
  if (k8s.enabled === false) {
    return samples;
  }
  if (!k8s.apiServerReachable) {
    samples.push({ metric: "k8s_apiserver_unreachable", value: 1 });
  }
  const notReady = Math.max(0, (k8s.nodesTotal ?? 0) - (k8s.nodesReady ?? 0));
  if (notReady > 0) {
    samples.push({ metric: "k8s_node_not_ready", value: notReady });
  }
  if ((k8s.podsPending ?? 0) > 0) {
    samples.push({ metric: "k8s_pod_pending", value: k8s.podsPending });
  }
  if ((k8s.podsCrashLoop ?? 0) > 0) {
    samples.push({ metric: "k8s_pod_crashloop", value: k8s.podsCrashLoop });
  }
  if ((k8s.deploymentsUnhealthy ?? 0) > 0) {
    samples.push({
      metric: "k8s_deployment_unhealthy",
      value: k8s.deploymentsUnhealthy,
    });
  }
  return samples;
}

type RuleDefault = {
  name: string;
  metric: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  threshold: number;
  warnThreshold?: number | null;
  alarmThreshold?: number | null;
};

async function ensureRules(orgId: string, defaults: ReadonlyArray<RuleDefault>) {
  const db = await getDb();
  for (const rule of defaults) {
    const existing = await db.query(
      `SELECT id FROM alert_rules WHERE org_id = $1 AND metric = $2 LIMIT 1`,
      [orgId, rule.metric],
    );
    if (existing.rows[0]) continue;
    const alarm = rule.alarmThreshold ?? rule.threshold;
    const warn = rule.warnThreshold ?? null;
    await db.query(
      `INSERT INTO alert_rules (
         id, org_id, name, metric, operator, threshold, warn_threshold, alarm_threshold, enabled
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
      [
        newId("rul"),
        orgId,
        rule.name,
        rule.metric,
        rule.operator,
        alarm,
        warn,
        alarm,
      ],
    );
  }
}

/** Backfill warn/alarm columns on legacy single-threshold host rules. */
async function migrateHostBandThresholds(orgId: string) {
  const db = await getDb();
  await db.query(
    `UPDATE alert_rules
     SET alarm_threshold = threshold
     WHERE org_id = $1 AND alarm_threshold IS NULL`,
    [orgId],
  );

  for (const metric of ["cpu_percent", "mem_percent", "disk_percent"] as const) {
    const defaults = hostBandDefaultsForMetric(metric);
    if (!defaults) continue;
    await db.query(
      `UPDATE alert_rules
       SET warn_threshold = $3
       WHERE org_id = $1 AND metric = $2 AND warn_threshold IS NULL`,
      [orgId, metric, defaults.warn],
    );
  }
}

export async function ensureHostMetricRules(orgId: string) {
  await ensureDefaultThresholdRule(orgId);
  const cpu = hostBandDefaultsForMetric("cpu_percent")!;
  const mem = hostBandDefaultsForMetric("mem_percent")!;
  const disk = hostBandDefaultsForMetric("disk_percent")!;
  await ensureRules(orgId, [
    {
      name: "High CPU",
      metric: "cpu_percent",
      operator: "gte",
      threshold: cpu.alarm,
      warnThreshold: cpu.warn,
      alarmThreshold: cpu.alarm,
    },
    {
      name: "High memory",
      metric: "mem_percent",
      operator: "gte",
      threshold: mem.alarm,
      warnThreshold: mem.warn,
      alarmThreshold: mem.alarm,
    },
    {
      name: "High disk",
      metric: "disk_percent",
      operator: "gte",
      threshold: disk.alarm,
      warnThreshold: disk.warn,
      alarmThreshold: disk.alarm,
    },
    { name: "Mount missing", metric: "mount_missing", operator: "gte", threshold: 1 },
    { name: "Container exited", metric: "container_exited", operator: "gte", threshold: 1 },
    { name: "Container OOM", metric: "container_oom", operator: "gte", threshold: 1 },
    {
      name: "Container restart loop",
      metric: "container_restart_loop",
      operator: "gte",
      threshold: 1,
    },
    {
      name: "Container memory vs limit",
      metric: "container_mem_limit_pct",
      operator: "gte",
      threshold: 90,
    },
    {
      name: "K8s API unreachable",
      metric: "k8s_apiserver_unreachable",
      operator: "gte",
      threshold: 1,
    },
    {
      name: "K8s node not Ready",
      metric: "k8s_node_not_ready",
      operator: "gte",
      threshold: 1,
    },
    {
      name: "K8s pod Pending",
      metric: "k8s_pod_pending",
      operator: "gte",
      threshold: 1,
    },
    {
      name: "K8s pod CrashLoop",
      metric: "k8s_pod_crashloop",
      operator: "gte",
      threshold: 1,
    },
    {
      name: "K8s deployment unhealthy",
      metric: "k8s_deployment_unhealthy",
      operator: "gte",
      threshold: 1,
    },
  ]);
  await migrateHostBandThresholds(orgId);
}

export async function ingestAgentMetrics(
  input: MetricsIngestInput,
): Promise<MetricsIngestResult> {
  const agentId = input.agentId?.trim();
  if (!agentId) return { ok: false, error: "agentId is required", status: 400 };
  if (!Number.isFinite(input.cpuPercent) || !Number.isFinite(input.memPercent)) {
    return { ok: false, error: "cpuPercent and memPercent are required", status: 400 };
  }

  const db = await getDb();
  const agentRes = await db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1`, [
    agentId,
  ]);
  const agent = agentRes.rows[0];
  if (!agent) return { ok: false, error: "agent not found", status: 404 };

  const clusterId =
    input.clusterId?.trim() ||
    input.kubernetes?.clusterId?.trim() ||
    agent.cluster_id ||
    "default";

  await ensureCluster(agent.org_id, clusterId);

  const collectedAt = input.collectedAt
    ? new Date(input.collectedAt).toISOString()
    : new Date().toISOString();
  const disksJson = JSON.stringify(input.disks ?? []);
  const mountsJson = JSON.stringify(input.mounts ?? []);
  const sampleId = newId("met");

  await db.query(
    `UPDATE agents SET last_seen_at = NOW(), cluster_id = $2 WHERE id = $1`,
    [agentId, clusterId],
  );

  await db.query(
    `INSERT INTO agent_metric_samples (
      id, agent_id, org_id, collected_at, cpu_percent, mem_percent,
      mem_used_bytes, mem_total_bytes, load1, load5, load15, disks_json, mounts_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      sampleId,
      agentId,
      agent.org_id,
      collectedAt,
      input.cpuPercent,
      input.memPercent,
      input.memUsedBytes ?? 0,
      input.memTotalBytes ?? 0,
      input.load1 ?? 0,
      input.load5 ?? 0,
      input.load15 ?? 0,
      disksJson,
      mountsJson,
    ],
  );

  await db.query(
    `INSERT INTO agent_metric_latest (
      agent_id, org_id, collected_at, cpu_percent, mem_percent,
      mem_used_bytes, mem_total_bytes, load1, load5, load15, disks_json, mounts_json, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (agent_id) DO UPDATE SET
      org_id = EXCLUDED.org_id,
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
      agent.org_id,
      collectedAt,
      input.cpuPercent,
      input.memPercent,
      input.memUsedBytes ?? 0,
      input.memTotalBytes ?? 0,
      input.load1 ?? 0,
      input.load5 ?? 0,
      input.load15 ?? 0,
      disksJson,
      mountsJson,
    ],
  );

  let containers = input.containers;
  if (containers) {
    containers = markContainerExitAlerts(
      containers,
      await loadPreviousContainers(agentId),
    );
    await db.query(
      `INSERT INTO agent_containers_latest (
        agent_id, org_id, runtime, containers_json, collected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        runtime = EXCLUDED.runtime,
        containers_json = EXCLUDED.containers_json,
        collected_at = EXCLUDED.collected_at,
        updated_at = NOW()`,
      [
        agentId,
        agent.org_id,
        input.containerRuntime ?? "none",
        JSON.stringify(containers),
        collectedAt,
      ],
    );
  }

  if (input.kubernetes) {
    const summary = {
      ...input.kubernetes,
      clusterId,
    };
    await db.query(
      `INSERT INTO agent_k8s_latest (
        agent_id, org_id, cluster_id, summary_json, collected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        cluster_id = EXCLUDED.cluster_id,
        summary_json = EXCLUDED.summary_json,
        collected_at = EXCLUDED.collected_at,
        updated_at = NOW()`,
      [agentId, agent.org_id, clusterId, JSON.stringify(summary), collectedAt],
    );
  }

  await ensureHostMetricRules(agent.org_id);
  // Throttle-delete samples older than org retention.
  void maybePurgeOrgMetrics(agent.org_id).catch(() => undefined);
  const rules = await listAlertRules(agent.org_id);
  const channels = await listAlertChannels(agent.org_id);
  const prefs = await listNotificationPrefs(agent.org_id);
  const thresholdSamples = samplesFromMetrics({
    ...input,
    containers,
    kubernetes: input.kubernetes
      ? { ...input.kubernetes, clusterId }
      : input.kubernetes,
  });

  let alertsFired = 0;
  // Track which alert identities are still breaching vs. seen healthy.
  const breaching = new Set<string>();
  const healthy = new Set<string>();
  for (const sample of thresholdSamples) {
    for (const rule of rules) {
      if (!rule.enabled || !ruleMatchesMetric(rule.metric, sample.metric)) continue;
      const b = evaluateRuleBand(rule, sample);
      const over = b != null ? b !== "green" : evaluateRule(rule, sample);
      (over ? breaching : healthy).add(
        alertFingerprint({
          orgId: agent.org_id,
          ruleOrSource: rule.id,
          agentOrAlarmId: agentId,
          metricOrName: sample.metric,
        }),
      );
    }
  }
  const resolved = await resolveRecoveredAlerts({
    orgId: agent.org_id,
    agentId,
    breaching,
    healthy,
  });
  // enqueueAlert honours the global pause; quiet hours suppress (info severity).
  for (const payload of buildRecoveryPayloads({
    resolved,
    rules,
    hostname: agent.hostname,
    samples: thresholdSamples,
  })) {
    enqueueAlert({ channels, payload, prefs });
  }

  if (!areAlertsPaused()) {
    for (const sample of thresholdSamples) {
      for (const rule of rules) {
        const band = evaluateRuleBand(rule, sample);
        if (band === "green") continue;

        let isWarnOnly = false;
        let isAlarm = false;
        if (band === "yellow") {
          isWarnOnly = true;
        } else if (band === "red") {
          isAlarm = true;
        } else if (!evaluateRule(rule, sample)) {
          continue;
        } else {
          isAlarm = true;
        }

        const coolKey = alertCooldownKey({
          orgId: agent.org_id,
          ruleId: rule.id,
          agentId,
          metric: `${sample.metric}:${isWarnOnly ? "warn" : "alarm"}`,
        });
        if (!shouldFireAlert(coolKey)) continue;

        const fingerprint = alertFingerprint({
          orgId: agent.org_id,
          ruleOrSource: rule.id,
          agentOrAlarmId: agentId,
          metricOrName: sample.metric,
        });
        if (await isFingerprintMuted(agent.org_id, fingerprint)) {
          continue;
        }

        const alarm = effectiveAlarm(rule);
        const warn = effectiveWarn(rule);
        // Dual-band red → critical notify; yellow → warning history only;
        // binary rules (no warn band) keep warning severity for notify.
        const severity =
          band === "red" ? ("critical" as const) : ("warning" as const);
        const thresholdLabel =
          isWarnOnly && warn != null
            ? `warn ${warn}`
            : `${rule.operator} ${alarm}`;
        const eventId = newId("evt");
        const mountPath = sample.metric.startsWith("mount_missing:")
          ? sample.metric.slice("mount_missing:".length)
          : undefined;
        const exited = sample.metric.startsWith("container_exited:")
          ? (containers ?? []).find(
              (c) => containerKey(c) === sample.metric.slice("container_exited:".length),
            )
          : undefined;
        // Stored event message stays machine-ish (searchable, stable); the
        // notification gets a readable sentence with units.
        const eventMessage = `${sample.metric} ${thresholdLabel} (observed ${sample.value})`;
        const friendlyThreshold =
          isWarnOnly && warn != null
            ? formatThreshold(rule.operator, warn, sample.metric)
            : formatThreshold(rule.operator, alarm, sample.metric);
        const observed = formatMetricValue(sample.metric, sample.value);
        const payload = {
          subject: `${rule.name} on ${agent.hostname}`,
          message: mountPath
            ? `Mount ${mountPath} is missing.`
            : exited
              ? `Container ${containerKey(exited)} ${describeExit(exited)}.`
              : `${metricLabel(sample.metric)} is ${observed} (${isWarnOnly ? "warn" : "alarm"} at ${friendlyThreshold}).`,
          severity,
          hostname: agent.hostname,
          deepLink: alertDeepLink(eventId),
          fields: [
            { label: "Host", value: agent.hostname },
            { label: "Metric", value: metricLabel(sample.metric) },
            ...(mountPath
              ? [{ label: "Mount path", value: mountPath }]
              : exited
                ? [
                    { label: "Container", value: containerKey(exited) },
                    { label: "Image", value: exited.image || "unknown" },
                    {
                      label: "Exit code",
                      value: exited.exitCode != null ? String(exited.exitCode) : "unknown",
                    },
                  ]
                : [
                  { label: "Observed", value: observed },
                  { label: "Threshold", value: friendlyThreshold },
                ]),
            { label: "Started", value: formatTimestamp(new Date()) },
          ],
        };

        // Never block metrics ingest on SMTP/webhook delivery.
        // Yellow: history only; red/binary: notify channels.
        if (isAlarm) {
          enqueueAlert({ channels, payload, prefs });
        }
        await insertAlertEvent({
          id: eventId,
          orgId: agent.org_id,
          ruleId: rule.id,
          severity,
          message: eventMessage,
          fingerprint,
          payload: {
            agentId,
            hostname: agent.hostname,
            clusterId,
            sample,
            band: band ?? "alarm",
            ...(mountPath ? { mountPath } : {}),
            ...(exited
              ? {
                  container: {
                    name: containerKey(exited),
                    image: exited.image,
                    exitCode: exited.exitCode ?? null,
                  },
                }
              : {}),
          },
        });
        alertsFired += 1;
      }
    }
  }

  const refreshed = (
    await db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1`, [agentId])
  ).rows[0];

  return {
    ok: true,
    agent: refreshed,
    sampleId,
    alertsFired,
    lastSeenAt: new Date(refreshed.last_seen_at).toISOString(),
  };
}

function describeExit(c: ContainerMetric): string {
  if ((c.state || "").toLowerCase() === "dead") return "is dead";
  if (c.exitCode == null) return "exited";
  const signal =
    c.exitCode === 137 ? " (SIGKILL)" : c.exitCode === 143 ? " (SIGTERM)" : "";
  return `exited with code ${c.exitCode}${signal}`;
}

export async function getLatestContainers(
  agentId: string,
): Promise<ContainersLatestRow | null> {
  const db = await getDb();
  const result = await db.query<ContainersLatestRow>(
    `SELECT * FROM agent_containers_latest WHERE agent_id = $1`,
    [agentId],
  );
  return result.rows[0] ?? null;
}

export async function listLatestContainers(
  orgId: string,
): Promise<ContainersLatestRow[]> {
  const db = await getDb();
  // Join agents so rows survive org moves (stale latest.org_id after Bootstrap→wizard).
  const result = await db.query<ContainersLatestRow>(
    `SELECT c.* FROM agent_containers_latest c
     INNER JOIN agents a ON a.id = c.agent_id
     WHERE a.org_id = $1`,
    [orgId],
  );
  return result.rows;
}

export async function getLatestK8s(agentId: string): Promise<K8sLatestRow | null> {
  const db = await getDb();
  const result = await db.query<K8sLatestRow>(
    `SELECT * FROM agent_k8s_latest WHERE agent_id = $1`,
    [agentId],
  );
  return result.rows[0] ?? null;
}

export async function listLatestK8s(orgId: string): Promise<K8sLatestRow[]> {
  const db = await getDb();
  // Join agents so Fleet sees samples after agent org_id moves (wizard adopt).
  const result = await db.query<K8sLatestRow>(
    `SELECT k.* FROM agent_k8s_latest k
     INNER JOIN agents a ON a.id = k.agent_id
     WHERE a.org_id = $1
     ORDER BY k.updated_at DESC`,
    [orgId],
  );
  return result.rows;
}

function parseK8sRow(
  row: K8sLatestRow,
): { clusterId: string; summary: K8sClusterMetric; row: K8sLatestRow } | null {
  try {
    const summary = JSON.parse(row.summary_json) as K8sClusterMetric;
    return { clusterId: row.cluster_id, summary, row };
  } catch {
    return null;
  }
}

function k8sRowEnabled(row: K8sLatestRow): boolean {
  try {
    const summary = JSON.parse(row.summary_json) as K8sClusterMetric;
    if (summary.enabled === false) return false;
    if (summary.enabled === true) return true;
    // Legacy: unreachable empty → treat as disabled for preference ordering.
    if (
      !summary.apiServerReachable &&
      (summary.nodesTotal ?? 0) === 0 &&
      !(summary.apiServerError && String(summary.apiServerError).trim())
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Resolve K8s snapshot for the org's active cluster (multi-cluster). */
export async function getActiveClusterK8s(
  orgId: string,
  preferredClusterId?: string,
): Promise<{ clusterId: string; summary: K8sClusterMetric; row: K8sLatestRow } | null> {
  const rows = await listLatestK8s(orgId);
  if (rows.length === 0) return null;

  let activeId = preferredClusterId;
  if (!activeId) {
    try {
      const { getActiveClusterId } = await import("@/lib/clusters/store");
      activeId = await getActiveClusterId(orgId);
    } catch {
      activeId = "default";
    }
  }

  // Prefer an *enabled* sample for the active cluster (skip Compose disabled stubs
  // that share the same cluster_id), then any sample for active, then fallbacks.
  const forActive = rows.filter((r) => r.cluster_id === activeId);
  const preferred =
    forActive.find((r) => k8sRowEnabled(r)) ??
    forActive[0] ??
    rows.find((r) => r.cluster_id === "default" && k8sRowEnabled(r)) ??
    rows.find((r) => k8sRowEnabled(r)) ??
    rows.find((r) => r.cluster_id === "default") ??
    rows[0] ??
    null;
  if (!preferred) return null;
  return parseK8sRow(preferred);
}

export async function listClusterK8sSummaries(
  orgId: string,
): Promise<Array<{ clusterId: string; summary: K8sClusterMetric }>> {
  const rows = await listLatestK8s(orgId);
  const byCluster = new Map<string, K8sLatestRow>();
  for (const row of rows) {
    const prev = byCluster.get(row.cluster_id);
    if (!prev || new Date(row.updated_at) > new Date(prev.updated_at)) {
      byCluster.set(row.cluster_id, row);
    }
  }
  const out: Array<{ clusterId: string; summary: K8sClusterMetric }> = [];
  for (const [clusterId, row] of byCluster) {
    try {
      out.push({
        clusterId,
        summary: JSON.parse(row.summary_json) as K8sClusterMetric,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function getLatestMetrics(
  agentId: string,
): Promise<MetricLatestRow | null> {
  const db = await getDb();
  const result = await db.query<MetricLatestRow>(
    `SELECT * FROM agent_metric_latest WHERE agent_id = $1`,
    [agentId],
  );
  return result.rows[0] ?? null;
}

export async function listLatestMetrics(
  orgId: string,
): Promise<MetricLatestRow[]> {
  const db = await getDb();
  // Join agents: latest.org_id can lag after Bootstrap→wizard agent moves.
  const result = await db.query<MetricLatestRow>(
    `SELECT m.* FROM agent_metric_latest m
     INNER JOIN agents a ON a.id = m.agent_id
     WHERE a.org_id = $1`,
    [orgId],
  );
  return result.rows;
}

export async function listMetricHistory(
  agentId: string,
  limit = 60,
): Promise<MetricSampleRow[]> {
  const db = await getDb();
  const result = await db.query<MetricSampleRow>(
    `SELECT * FROM agent_metric_samples
     WHERE agent_id = $1
     ORDER BY collected_at DESC
     LIMIT $2`,
    [agentId, limit],
  );
  return result.rows.reverse();
}

export async function getAgentById(agentId: string): Promise<AgentRow | null> {
  const db = await getDb();
  const result = await db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1`, [
    agentId,
  ]);
  return result.rows[0] ?? null;
}
