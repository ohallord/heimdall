import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bootstrapStatus,
  disableBootstrapToken,
  revertBootstrapToEnv,
  rotateBootstrapToken,
} from "@/lib/agents/bootstrap";
import { requireSession } from "@/lib/auth/session";
import { ensureBootstrapOrg } from "@/lib/db/store";
import { mutating } from "@/lib/http-guard/mutating";

export const dynamic = "force-dynamic";

const schema = z.object({ action: z.enum(["rotate", "disable", "revert"]) });

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status });
}

/** The bootstrap token is hub-wide: only admins of the bootstrap org may change it. */
async function canManage(session: { role?: string; orgId?: string }): Promise<boolean> {
  if (session.role !== "admin" || !session.orgId) return false;
  return (await ensureBootstrapOrg()).id === session.orgId;
}

/** GET /api/v1/admin/bootstrap-token — mode, hint, weak flag (never the token or its hash). */
export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    return NextResponse.json({ ...(await bootstrapStatus()), canManage: await canManage(session) });
  } catch (err) {
    return fail(err);
  }
}

/** POST { action: rotate | disable | revert }. Rotate returns the new token once. */
async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    if (!(await canManage(session))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: "action must be rotate, disable or revert" }, { status: 400 });
    }
    const userId = session.userId ?? null;
    if (body.data.action === "rotate") {
      const { token } = await rotateBootstrapToken(userId);
      return NextResponse.json({
        token,
        helmCommand:
          "helm -n heimdall upgrade heimdall deploy/helm/heimdall --reset-then-reuse-values " +
          `--set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN=${token}`,
        composeHint: `Set HEIMDALL_BOOTSTRAP_TOKEN=${token} in deploy/docker/.env, then docker compose up -d`,
        status: await bootstrapStatus(),
      });
    }
    if (body.data.action === "disable") await disableBootstrapToken(userId);
    else await revertBootstrapToEnv(userId);
    return NextResponse.json({ status: await bootstrapStatus() });
  } catch (err) {
    return fail(err);
  }
}

export const POST = mutating(postHandler);
