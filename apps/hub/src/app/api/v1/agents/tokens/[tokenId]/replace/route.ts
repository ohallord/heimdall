import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { requireSession } from "@/lib/auth/session";
import { createAgentToken, getAgentToken, revokeAgentToken } from "@/lib/db/store";
import { installCommandsFor } from "@/lib/host-dist";
import { mutating } from "@/lib/http-guard/mutating";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ tokenId: string }> };

/**
 * POST /api/v1/agents/tokens/:tokenId/replace — revoke an enrollment token and mint a new one
 * with the same name, lifetime and max uses. The new token is shown once. Registered agents are
 * unaffected (they use per-agent secrets).
 */
async function postHandler(request: Request, ctx: Ctx) {
  try {
    const session = await requireSession({ permission: "agents:write" });
    const { tokenId } = await ctx.params;
    const old = await getAgentToken(tokenId, session.orgId!);
    if (!old) return NextResponse.json({ error: "token not found" }, { status: 404 });

    const lifetimeMs = old.expires_at
      ? Math.max(60_000, new Date(old.expires_at).getTime() - new Date(old.created_at).getTime())
      : null;
    await revokeAgentToken(old.id, session.orgId!);
    const { token, row } = await createAgentToken({
      orgId: session.orgId!,
      name: old.name,
      createdBy: session.userId,
      expiresAt: lifetimeMs ? new Date(Date.now() + lifetimeMs) : null,
      maxUses: old.max_uses ?? null,
    });
    return NextResponse.json(
      {
        id: row.id,
        name: row.name,
        token,
        hint: row.token_hint,
        expiresAt: row.expires_at,
        maxUses: row.max_uses,
        replaced: old.id,
        installCommands: installCommandsFor(request, token),
      },
      { status: 201 },
    );
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
