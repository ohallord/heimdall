import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { revokeAgentPersistent } from "@/lib/db/store";
import { mutating } from "@/lib/http-guard/mutating";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

/** POST /api/v1/agents/:agentId/revoke (agents:write, session + CSRF + MFA for admins). */
async function postHandler(_req: Request, ctx: Ctx) {
  try {
    const session = await requireSession({ permission: "agents:write" });
    const { agentId } = await ctx.params;
    const ok = await revokeAgentPersistent(agentId, session.orgId!);
    if (!ok) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    return NextResponse.json({ ok: true, id: agentId });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status });
  }
}

export const POST = mutating(postHandler);
