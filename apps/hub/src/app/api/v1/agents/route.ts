import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { listAgents } from "@/lib/agents";
import { requireSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    if (!session.orgId) {
      return NextResponse.json({ error: "no org" }, { status: 400 });
    }
    const agents = await listAgents(session.orgId);
    return NextResponse.json({
      agents: agents.map((agent) => ({
        id: agent.id,
        hostname: agent.hostname,
        version: agent.version,
        registeredAt: agent.registeredAt,
        lastSeenAt: agent.lastSeenAt,
        revokedAt: agent.revokedAt ?? null,
        legacy: agent.legacy ?? false,
      })),
    });
  } catch (err) {
    return apiError(err);
  }
}
