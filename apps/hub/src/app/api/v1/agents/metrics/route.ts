import { NextResponse } from "next/server";
import { guardIngest } from "@/lib/http-guard/ingest";
import { authorizeAgentIngest } from "@/lib/agents/ingest-auth";
import { ingestAgentMetrics } from "@/lib/metrics/ingest";
import type {
  ContainerMetric,
  DiskMetric,
  K8sClusterMetric,
  MountMetric,
} from "@/lib/db/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guarded = await guardIngest(request, { name: "INGEST", route: "agents/metrics", maxBytes: 1048576 });
  if (!guarded.ok) return guarded.response;
  const body = guarded.value;

  const record = (body ?? {}) as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId : "";
  const auth = await authorizeAgentIngest(request, agentId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await ingestAgentMetrics({
    agentId: auth.agent.id,
    clusterId:
      typeof record.clusterId === "string" ? record.clusterId : undefined,
    collectedAt:
      typeof record.collectedAt === "string" ? record.collectedAt : undefined,
    cpuPercent: Number(record.cpuPercent),
    memPercent: Number(record.memPercent),
    memUsedBytes: Number(record.memUsedBytes ?? 0),
    memTotalBytes: Number(record.memTotalBytes ?? 0),
    load1: Number(record.load1 ?? 0),
    load5: Number(record.load5 ?? 0),
    load15: Number(record.load15 ?? 0),
    disks: Array.isArray(record.disks) ? (record.disks as DiskMetric[]) : [],
    mounts: Array.isArray(record.mounts)
      ? (record.mounts as MountMetric[])
      : [],
    containerRuntime:
      typeof record.containerRuntime === "string"
        ? record.containerRuntime
        : undefined,
    containers: Array.isArray(record.containers)
      ? (record.containers as ContainerMetric[])
      : [],
    kubernetes:
      record.kubernetes && typeof record.kubernetes === "object"
        ? (record.kubernetes as K8sClusterMetric)
        : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    {
      accepted: true,
      agentId: result.agent.id,
      sampleId: result.sampleId,
      lastSeenAt: result.lastSeenAt,
      alertsFired: result.alertsFired,
    },
    { status: 202 },
  );
}
