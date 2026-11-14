import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { apiError } from "@/lib/http-guard/api-error";
import { mutating } from "@/lib/http-guard/mutating";
import { validateCron } from "@/lib/security/cron";
import { getSecuritySyncSchedule, saveSecuritySyncSchedule } from "@/lib/security/schedule";

export const dynamic = "force-dynamic";

const schema = z.object({
  cron: z.string().max(200),
  enabled: z.boolean(),
});

/** GET /api/v1/admin/security-sync-schedule — cron, time zone, next and last run. Admin only. */
export async function GET() {
  try {
    const session = await requireSession({ permission: "settings:write" });
    return NextResponse.json(await getSecuritySyncSchedule(session.orgId!));
  } catch (err) {
    return apiError(err);
  }
}

/** PUT { cron, enabled } — saves the org's scheduled GitHub/GitLab remote sync. */
async function putHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: "cron (string) and enabled (boolean) required" }, { status: 400 });
    }
    const reason = validateCron(body.data.cron);
    if (reason) return NextResponse.json({ error: `invalid cron: ${reason}` }, { status: 400 });
    const saved = await saveSecuritySyncSchedule(session.orgId!, {
      cron: body.data.cron,
      enabled: body.data.enabled,
      updatedBy: session.userId ?? null,
    });
    return NextResponse.json(saved);
  } catch (err) {
    return apiError(err);
  }
}

export const PUT = mutating(putHandler);
