import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { dispatchAlert, evaluateRule } from "@/lib/alerts/engine";
import { requireSession } from "@/lib/auth/session";
import { alertDeepLink } from "@/lib/alerts/format";
import {
  ensureDefaultThresholdRule,
  insertAlertEvent,
  listAlertChannels,
  listAlertRules,
  listNotificationPrefs,
} from "@/lib/db/store";
import { newId } from "@/lib/ids";

export const dynamic = "force-dynamic";

const schema = z.object({
  metric: z.string().default("agent_offline_minutes"),
  value: z.number().default(10),
  dryRun: z.boolean().optional().default(true),
});

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const body = schema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }

    await ensureDefaultThresholdRule(session.orgId!);
    const rules = await listAlertRules(session.orgId!);
    const matched = rules.filter((rule) =>
      evaluateRule(rule, { metric: body.data.metric, value: body.data.value }),
    );

    if (matched.length === 0) {
      return NextResponse.json({
        fired: false,
        reason: "no threshold matched",
        sample: body.data,
      });
    }

    const eventId = newId("evt");
    const payload = {
      subject: matched[0].name,
      message: `Threshold ${matched[0].metric} ${matched[0].operator} ${matched[0].threshold} (observed ${body.data.value})`,
      severity: "warning" as const,
      deepLink: alertDeepLink(eventId),
      fields: [
        { label: "Metric", value: matched[0].metric },
        { label: "Observed", value: String(body.data.value) },
        {
          label: "Threshold",
          value: `${matched[0].operator} ${matched[0].threshold}`,
        },
      ],
    };

    const channels = await listAlertChannels(session.orgId!);
    const prefs = await listNotificationPrefs(session.orgId!);
    let results: { ok: boolean; channel: string; detail?: string }[] =
      channels.map((c) => ({
        ok: true,
        channel: c.kind,
        detail: "dry-run",
      }));

    if (!body.data.dryRun) {
      results = await dispatchAlert(channels, payload, { prefs });
    }

    await insertAlertEvent({
      id: eventId,
      orgId: session.orgId!,
      ruleId: matched[0].id,
      severity: "warning",
      message: payload.message,
      payload: { sample: body.data, results },
    });

    return NextResponse.json({
      fired: true,
      dryRun: body.data.dryRun,
      rule: matched[0].name,
      results,
    });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
