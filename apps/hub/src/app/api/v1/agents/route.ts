import { NextResponse } from "next/server";
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
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}
