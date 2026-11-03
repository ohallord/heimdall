import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import {
  getOrCreateNotificationPrefs,
  upsertNotificationPrefs,
} from "@/lib/db/store";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  notifySmtp: z.boolean().optional(),
  notifySlack: z.boolean().optional(),
  notifyDiscord: z.boolean().optional(),
  notifySms: z.boolean().optional(),
  smsPhone: z.string().nullable().optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietStart: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  quietEnd: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  timezone: z.string().min(1).optional(),
});

function serialize(row: Awaited<ReturnType<typeof getOrCreateNotificationPrefs>>) {
  return {
    userId: row.user_id,
    orgId: row.org_id,
    notifySmtp: row.notify_smtp,
    notifySlack: row.notify_slack,
    notifyDiscord: row.notify_discord,
    notifySms: row.notify_sms,
    smsPhone: row.sms_phone,
    quietHoursEnabled: row.quiet_hours_enabled,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    timezone: row.timezone,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function GET() {
  try {
    const session = await requireSession({ permission: "alerts:read" });
    const prefs = await getOrCreateNotificationPrefs({
      userId: session.userId!,
      orgId: session.orgId!,
    });
    return NextResponse.json({ prefs: serialize(prefs) });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

async function putHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:read" });
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const prefs = await upsertNotificationPrefs({
      userId: session.userId!,
      orgId: session.orgId!,
      ...body.data,
    });
    return NextResponse.json({ prefs: serialize(prefs) });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const PUT = mutating(putHandler);
