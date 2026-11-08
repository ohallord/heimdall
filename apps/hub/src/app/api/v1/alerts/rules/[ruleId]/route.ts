import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { updateAlertRuleThresholds } from "@/lib/db/store";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  warnThreshold: z.number().finite().nullable().optional(),
  alarmThreshold: z.number().finite().optional(),
  enabled: z.boolean().optional(),
});

async function patchHandler(
  request: Request,
  context: { params: Promise<{ ruleId: string }> },
) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const { ruleId } = await context.params;
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    if (
      body.data.warnThreshold === undefined &&
      body.data.alarmThreshold === undefined &&
      body.data.enabled === undefined
    ) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }

    const row = await updateAlertRuleThresholds({
      orgId: session.orgId!,
      ruleId,
      warnThreshold: body.data.warnThreshold,
      alarmThreshold: body.data.alarmThreshold,
      enabled: body.data.enabled,
    });
    if (!row) {
      return NextResponse.json({ error: "rule not found" }, { status: 404 });
    }
    return NextResponse.json({
      rule: {
        id: row.id,
        name: row.name,
        metric: row.metric,
        operator: row.operator,
        threshold: row.threshold,
        warnThreshold: row.warn_threshold,
        alarmThreshold: row.alarm_threshold ?? row.threshold,
        enabled: row.enabled,
      },
    });
  } catch (err) {
    return apiError(err);
  }
}

export const PATCH = mutating(patchHandler);
