import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { requireSession } from "@/lib/auth/session";
import { dismissAlertEventsBulk } from "@/lib/db/store";

export const dynamic = "force-dynamic";

/** Phase 26: mass-dismiss open/muted alerts older than N days (0 = all). */
async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const body = (await request.json().catch(() => ({}))) as {
      olderThanDays?: unknown;
    };
    const days = Number(body.olderThanDays);
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      return NextResponse.json(
        { error: "olderThanDays must be a number between 0 and 3650" },
        { status: 400 },
      );
    }
    const dismissed = await dismissAlertEventsBulk({
      orgId: session.orgId!,
      dismissedBy: session.userId!,
      olderThanDays: days,
    });
    return NextResponse.json({ dismissed });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
