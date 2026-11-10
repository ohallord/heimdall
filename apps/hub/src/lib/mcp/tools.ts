import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listAgents } from "@/lib/agents";
import { getPrimaryOrg, getSetupState, listAlertEvents, listAlertRules } from "@/lib/db/store";
import type {
  AlertEventRow,
  ContainersLatestRow,
  K8sLatestRow,
  MetricLatestRow,
  Organization,
  VulnFindingRow,
} from "@/lib/db/types";
import {
  getAgentById,
  getLatestContainers,
  getLatestK8s,
  getLatestMetrics,
  isAgentOnline,
} from "@/lib/metrics/ingest";
import { listFindings } from "@/lib/security/store";

/** Fleet and MCP lists stay short. Counts use the existing store caps. */
export const MCP_LIST_CAP = 20;
const ALERT_COUNT_CAP = 200;
const FINDING_COUNT_CAP = 500;

const SENSITIVE_KEY =
  /token|secret|authorization|password|credential|webhook|cookie|passwd/i;
const LOG_BODY_KEY = /^(logTail|log_body|body|line|raw_json|payload_json|config_json)$/;

const LIST_KEYS = new Set([
  "pods",
  "podProblems",
  "deployments",
  "exposedServices",
  "containers",
  "disks",
  "mounts",
  "nodesNotReady",
  "events",
  "withoutPolicy",
]);

export function redactPublic(value: unknown, depth = 0): unknown {
  if (depth > 12 || value == null) return value ?? null;
  if (Array.isArray(value)) {
    return value.slice(0, MCP_LIST_CAP).map((item) => redactPublic(item, depth + 1));
  }
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) || LOG_BODY_KEY.test(key)) continue;
    const next = redactPublic(child, depth + 1);
    out[key] = Array.isArray(next) && LIST_KEYS.has(key) ? next.slice(0, MCP_LIST_CAP) : next;
  }
  return out;
}

function toolOk(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolError(error: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }],
  };
}

async function primaryOrg(): Promise<Organization | null> {
  return getPrimaryOrg();
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hostnameFromPayload(raw: string): string | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const hostname = (parsed as { hostname?: unknown }).hostname;
  return typeof hostname === "string" && hostname ? hostname : null;
}

export async function heimdallStatus(): Promise<CallToolResult> {
  const org = await primaryOrg();
  if (!org) return toolError("no primary org");
  const [setup, agents, open] = await Promise.all([
    getSetupState(),
    listAgents(org.id),
    listAlertEvents(org.id, { status: "open", limit: ALERT_COUNT_CAP }),
  ]);
  return toolOk({
    ok: true,
    setupComplete: Boolean(setup.completed),
    agents: {
      total: agents.length,
      online: agents.filter((agent) => isAgentOnline(agent.lastSeenAt)).length,
      revoked: agents.filter((agent) => Boolean(agent.revokedAt)).length,
    },
    openAlerts: open.length,
  });
}

export async function heimdallAgents(): Promise<CallToolResult> {
  const org = await primaryOrg();
  if (!org) return toolError("no primary org");
  const agents = await listAgents(org.id);
  return toolOk({
    ok: true,
    total: agents.length,
    agents: agents.slice(0, MCP_LIST_CAP).map((agent) => ({
      id: agent.id,
      hostname: agent.hostname,
      version: agent.version,
      lastSeenAt: agent.lastSeenAt,
      online: isAgentOnline(agent.lastSeenAt),
      revokedAt: agent.revokedAt ?? null,
    })),
  });
}

export async function heimdallAgent(args: {
  id?: string;
  hostname?: string;
}): Promise<CallToolResult> {
  const org = await primaryOrg();
  if (!org) return toolError("no primary org");
  const id = args.id?.trim() ?? "";
  const hostname = args.hostname?.trim() ?? "";
  if (!id && !hostname) return toolError("id or hostname is required");

  const agents = await listAgents(org.id);
  let match = id ? agents.find((agent) => agent.id === id) : undefined;
  if (!id && hostname) match = agents.find((agent) => agent.hostname === hostname);
  if (id && hostname && match && match.hostname !== hostname) match = undefined;
  if (!match) return toolError("agent not found");

  const row = await getAgentById(match.id);
  if (!row || row.org_id !== org.id) return toolError("agent not found");

  const [metrics, containers, k8s] = await Promise.all([
    getLatestMetrics(row.id),
    getLatestContainers(row.id),
    getLatestK8s(row.id),
  ]);

  return toolOk(
    redactPublic({
      ok: true,
      agent: {
        id: match.id,
        hostname: match.hostname,
        version: match.version,
        lastSeenAt: match.lastSeenAt,
        online: isAgentOnline(match.lastSeenAt),
        revokedAt: match.revokedAt ?? null,
      },
      metrics: shapeMetrics(metrics),
      containers: shapeContainers(containers),
      kubernetes: shapeK8s(k8s),
    }),
  );
}

function shapeMetrics(row: MetricLatestRow | null): unknown {
  if (!row) return null;
  return {
    collectedAt: new Date(row.collected_at).toISOString(),
    cpuPercent: row.cpu_percent,
    memPercent: row.mem_percent,
    memUsedBytes: row.mem_used_bytes,
    memTotalBytes: row.mem_total_bytes,
    disks: parseJson(row.disks_json) ?? [],
    mounts: parseJson(row.mounts_json) ?? [],
  };
}

function shapeContainers(row: ContainersLatestRow | null): unknown {
  if (!row) return null;
  return {
    runtime: row.runtime,
    collectedAt: new Date(row.collected_at).toISOString(),
    containers: parseJson(row.containers_json) ?? [],
  };
}

function shapeK8s(row: K8sLatestRow | null): unknown {
  if (!row) return null;
  return {
    clusterId: row.cluster_id,
    collectedAt: new Date(row.collected_at).toISOString(),
    summary: parseJson(row.summary_json),
  };
}

export async function heimdallAlerts(): Promise<CallToolResult> {
  const org = await primaryOrg();
  if (!org) return toolError("no primary org");
  const [events, rules] = await Promise.all([
    listAlertEvents(org.id, { status: "open", limit: MCP_LIST_CAP }),
    listAlertRules(org.id),
  ]);
  const names = new Map(rules.map((rule) => [rule.id, rule.name]));
  return toolOk({
    ok: true,
    alerts: events.map((event) => shapeAlert(event, names)),
  });
}

function shapeAlert(event: AlertEventRow, names: Map<string, string>) {
  const rule =
    (event.rule_id && names.get(event.rule_id)) || event.rule_id || "unknown";
  return {
    rule,
    host: hostnameFromPayload(event.payload_json),
    state: event.status,
    time: new Date(event.created_at).toISOString(),
  };
}

export async function heimdallFindings(): Promise<CallToolResult> {
  const org = await primaryOrg();
  if (!org) return toolError("no primary org");
  const [findings, agents] = await Promise.all([
    listFindings(org.id, { limit: FINDING_COUNT_CAP }),
    listAgents(org.id),
  ]);
  const hosts = new Map(agents.map((agent) => [agent.id, agent.hostname]));
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const finding of findings) {
    const severity = finding.severity.toLowerCase();
    if (severity === "critical" || severity === "high" || severity === "medium" || severity === "low") {
      counts[severity] += 1;
    } else {
      counts.unknown += 1;
    }
  }
  return toolOk({
    ok: true,
    counts,
    findings: findings.slice(0, MCP_LIST_CAP).map((finding) => shapeFinding(finding, hosts)),
  });
}

function shapeFinding(finding: VulnFindingRow, hosts: Map<string, string>) {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    host: finding.agent_id ? (hosts.get(finding.agent_id) ?? null) : null,
  };
}

/** Tool handlers never throw a stack into the client. */
export async function guardTool(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch {
    return toolError("heimdall data unavailable");
  }
}
