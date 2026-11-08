import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { getAgentById } from "@/lib/metrics/ingest";
import { queryMetricHistory, type HistoryMetric } from "@/lib/metrics/history";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  metric: z.enum(["cpu", "memory", "disk"]),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  mount: z.string().min(1).max(512).optional(),
  maxPoints: z.coerce.number().int().min(50).max(5000).optional(),
});

type Ctx = { params: Promise<{ agentId: string }> };

export async function GET(request: Request, ctx: Ctx) {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const orgId = session.orgId;
    if (!orgId) {
      return NextResponse.json({ error: "no org" }, { status: 400 });
    }
    const { agentId } = await ctx.params;
    const agent = await getAgentById(agentId);
    if (!agent || agent.org_id !== orgId) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      metric: url.searchParams.get("metric") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      mount: url.searchParams.get("mount") ?? undefined,
      maxPoints: url.searchParams.get("maxPoints") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
    const from = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(to.getTime() - 24 * 60 * 60 * 1000);

    const result = await queryMetricHistory({
      orgId,
      agentId,
      metric: parsed.data.metric as HistoryMetric,
      from,
      to,
      mount: parsed.data.mount,
      maxPoints: parsed.data.maxPoints,
    });
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}
