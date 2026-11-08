import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { requireSession } from "@/lib/auth/session";
import { reenrollAgentPersistent } from "@/lib/db/store";
import { mutating } from "@/lib/http-guard/mutating";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

/** POST /api/v1/agents/:agentId/reenroll (agents:write, session + CSRF + MFA for admins). */
async function postHandler(_req: Request, ctx: Ctx) {
  try {
    const session = await requireSession({ permission: "agents:write" });
    const { agentId } = await ctx.params;
    const ok = await reenrollAgentPersistent(agentId, session.orgId!);
    if (!ok) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    return NextResponse.json({ ok: true, id: agentId });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
