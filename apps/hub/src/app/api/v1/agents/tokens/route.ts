import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { createAgentToken, listAgentTokens } from "@/lib/db/store";
import { mutating } from "@/lib/http-guard/mutating";
import { installCommandsFor } from "@/lib/host-dist";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(1).max(80).default("Enrollment token"),
  ttlHours: z.number().positive().max(24 * 365).optional(),
  maxUses: z.number().int().positive().optional(),
});

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status });
}

/** GET /api/v1/agents/tokens — list enrollment tokens (hints only). */
export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const rows = await listAgentTokens(session.orgId!);
    return NextResponse.json({
      tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        hint: t.token_hint,
        createdAt: t.created_at,
        expiresAt: t.expires_at,
        maxUses: t.max_uses,
        useCount: t.use_count,
        revokedAt: t.revoked_at,
      })),
    });
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/v1/agents/tokens — mint an enrollment token; the token is shown once. */
async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "agents:write" });
    const body = schema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    const { token, row } = await createAgentToken({
      orgId: session.orgId!,
      name: body.data.name,
      createdBy: session.userId,
      expiresAt: body.data.ttlHours ? new Date(Date.now() + body.data.ttlHours * 3_600_000) : null,
      maxUses: body.data.maxUses ?? null,
    });
    return NextResponse.json(
      {
        id: row.id,
        name: row.name,
        token,
        hint: row.token_hint,
        expiresAt: row.expires_at,
        maxUses: row.max_uses,
        installCommands: installCommandsFor(request, token),
      },
      { status: 201 },
    );
  } catch (err) {
    return fail(err);
  }
}

export const POST = mutating(postHandler);
