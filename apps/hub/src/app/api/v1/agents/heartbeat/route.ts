import { NextResponse } from "next/server";
import { guardIngest } from "@/lib/http-guard/ingest";
import { heartbeatAgent } from "@/lib/agents";
import { authorizeAgentIngest } from "@/lib/agents/ingest-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guarded = await guardIngest(request, { name: "INGEST", route: "agents/heartbeat", maxBytes: 65536 });
  if (!guarded.ok) return guarded.response;
  const body = guarded.value;

  const record = (body ?? {}) as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId : "";
  const auth = await authorizeAgentIngest(request, agentId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await heartbeatAgent(auth.agent.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    agentId: result.agent.id,
    lastSeenAt: result.agent.lastSeenAt,
    status: "alive",
  });
}
