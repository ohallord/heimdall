import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { requireSession } from "@/lib/auth/session";
import { serializeAlertEvent } from "@/lib/alerts/serialize";
import { unmuteAlertEvent } from "@/lib/db/store";

export const dynamic = "force-dynamic";

async function postHandler(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const { id } = await context.params;
    const event = await unmuteAlertEvent({
      orgId: session.orgId!,
      eventId: id,
    });
    if (!event) {
      return NextResponse.json({ error: "alert not found" }, { status: 404 });
    }
    return NextResponse.json({ event: serializeAlertEvent(event) });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
