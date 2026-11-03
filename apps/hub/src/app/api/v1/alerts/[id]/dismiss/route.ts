import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { serializeAlertEvent } from "@/lib/alerts/serialize";
import { dismissAlertEvent } from "@/lib/db/store";

export const dynamic = "force-dynamic";

async function postHandler(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const { id } = await context.params;
    const event = await dismissAlertEvent({
      orgId: session.orgId!,
      eventId: id,
      dismissedBy: session.userId!,
    });
    if (!event) {
      return NextResponse.json({ error: "alert not found" }, { status: 404 });
    }
    return NextResponse.json({ event: serializeAlertEvent(event) });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const POST = mutating(postHandler);
