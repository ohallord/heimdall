import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { deleteAgent } from "@/lib/agents";
import { requireSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

/** DELETE /api/v1/agents/:agentId — remove a stale/offline fleet host. */
async function deleteHandler(_req: Request, ctx: Ctx) {
  try {
    const session = await requireSession({ permission: "agents:write" });
    const { agentId } = await ctx.params;
    if (!session.orgId) {
      return NextResponse.json({ error: "no org" }, { status: 400 });
    }
    const result = await deleteAgent(agentId, session.orgId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, id: agentId });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const DELETE = mutating(deleteHandler);
