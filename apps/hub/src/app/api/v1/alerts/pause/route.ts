import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { areAlertsPaused, setAlertsPaused } from "@/lib/alerts/pause";
import { getDb } from "@/lib/db/client";
import { ensureBootstrapOrg } from "@/lib/db/store";

export const dynamic = "force-dynamic";

async function mayPauseHub(orgId: string): Promise<boolean> {
  const db = await getDb();
  const n = Number((await db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM organizations`)).rows[0]?.n ?? 0);
  if (n <= 1) return true;
  return (await ensureBootstrapOrg()).id === orgId;
}

const schema = z.object({
  paused: z.boolean(),
});

export async function GET() {
  try {
    await requireSession({ permission: "alerts:read" });
    return NextResponse.json({
      paused: areAlertsPaused(),
      envPaused:
        process.env.HEIMDALL_ALERTS_PAUSED === "true" ||
        process.env.HEIMDALL_ALERTS_PAUSED === "1",
    });
  } catch (err) {
    return apiError(err);
  }
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    // The pause is hub-wide. On a multi-org hub only the bootstrap org may flip it.
    if (!(await mayPauseHub(session.orgId!))) {
      return NextResponse.json({ error: "forbidden: alerts pause is hub-wide" }, { status: 403 });
    }
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    setAlertsPaused(body.data.paused);
    return NextResponse.json({ paused: areAlertsPaused() });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
