import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { requireSession } from "@/lib/auth/session";
import { revokeAgentToken } from "@/lib/db/store";
import { mutating } from "@/lib/http-guard/mutating";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ tokenId: string }> };

/** DELETE /api/v1/agents/tokens/:tokenId — revoke an enrollment token. */
async function deleteHandler(_req: Request, ctx: Ctx) {
  try {
    const session = await requireSession({ permission: "agents:write" });
    const { tokenId } = await ctx.params;
    const ok = await revokeAgentToken(tokenId, session.orgId!);
    if (!ok) return NextResponse.json({ error: "token not found" }, { status: 404 });
    return NextResponse.json({ ok: true, id: tokenId });
  } catch (err) {
    return apiError(err);
  }
}

export const DELETE = mutating(deleteHandler);
