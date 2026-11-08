import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { isMutePreset } from "@/lib/alerts/fingerprint";
import { requireSession } from "@/lib/auth/session";
import { serializeAlertEvent } from "@/lib/alerts/serialize";
import { muteAlertEvent } from "@/lib/db/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  minutes: z.number().int().refine(isMutePreset, {
    message: "minutes must be 15, 30, 60, or 240",
  }),
});

async function postHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const { id } = await context.params;
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const event = await muteAlertEvent({
      orgId: session.orgId!,
      eventId: id,
      minutes: body.data.minutes,
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
