import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import {
  ensureClusterRecord,
  getActiveClusterId,
  listClusters,
  renameCluster,
} from "@/lib/clusters/store";
import { listClusterK8sSummaries } from "@/lib/metrics/ingest";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  clusterId: z.string().min(1).max(64),
  name: z.string().min(1).max(128).optional(),
});

const patchSchema = z.object({
  clusterId: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
});

export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const orgId = session.orgId!;
    const [clusters, activeClusterId, k8s] = await Promise.all([
      listClusters(orgId),
      getActiveClusterId(orgId),
      listClusterK8sSummaries(orgId),
    ]);
    const k8sById = new Map(k8s.map((k) => [k.clusterId, k.summary]));
    return NextResponse.json({
      activeClusterId,
      clusters: clusters.map((c) => ({
        id: c.id,
        clusterId: c.cluster_id,
        name: c.name,
        isActive: Boolean(c.is_active) || c.cluster_id === activeClusterId,
        kubernetes: k8sById.get(c.cluster_id) ?? null,
      })),
    });
  } catch (err) {
    return apiError(err);
  }
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const body = postSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const row = await ensureClusterRecord({
      orgId: session.orgId!,
      clusterId: body.data.clusterId,
      name: body.data.name,
    });
    return NextResponse.json({
      cluster: {
        id: row.id,
        clusterId: row.cluster_id,
        name: row.name,
        isActive: Boolean(row.is_active),
      },
    });
  } catch (err) {
    return apiError(err);
  }
}

async function patchHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const row = await renameCluster({
      orgId: session.orgId!,
      clusterId: body.data.clusterId,
      name: body.data.name,
    });
    if (!row) {
      return NextResponse.json({ error: "cluster not found" }, { status: 404 });
    }
    return NextResponse.json({
      cluster: {
        id: row.id,
        clusterId: row.cluster_id,
        name: row.name,
        isActive: Boolean(row.is_active),
      },
    });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);

export const PATCH = mutating(patchHandler);
