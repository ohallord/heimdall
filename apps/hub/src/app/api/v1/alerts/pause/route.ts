import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { areAlertsPaused, setAlertsPaused } from "@/lib/alerts/pause";

export const dynamic = "force-dynamic";

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
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

async function postHandler(request: Request) {
  try {
    await requireSession({ permission: "alerts:write" });
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    setAlertsPaused(body.data.paused);
    return NextResponse.json({ paused: areAlertsPaused() });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const POST = mutating(postHandler);
