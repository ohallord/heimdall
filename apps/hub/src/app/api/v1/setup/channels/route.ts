import { mutating } from "@/lib/http-guard/mutating";
import { recordAudit } from "@/lib/audit/log";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { smtpProbeUrl, validateChannelConfig } from "@/lib/alerts/channels";
import { setupClosed } from "@/lib/auth/setup-guard";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { rejectBlockedUrls } from "@/lib/http-guard/validate-url";
import {
  ensureDefaultThresholdRule,
  setSetupStep,
  upsertAlertChannel,
} from "@/lib/db/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  smtp: z
    .object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      secure: z.boolean().optional(),
      user: z.string().optional(),
      pass: z.string().optional(),
      from: z.string().min(1),
      to: z.string().min(1),
    })
    .optional(),
  slackWebhookUrl: z.string().url().optional().or(z.literal("")),
  discordWebhookUrl: z.string().url().optional().or(z.literal("")),
  sms: z
    .object({
      accountSid: z.string().min(1),
      authToken: z.string().min(1),
      from: z.string().min(1),
      to: z.string().min(1),
      apiBaseUrl: z.string().url().optional(),
    })
    .optional(),
  ntfy: z
    .object({
      serverUrl: z.string().url().optional(),
      topic: z.string().min(1),
      token: z.string().optional(),
    })
    .optional(),
  pushover: z
    .object({
      appToken: z.string().min(1),
      userKey: z.string().min(1),
      device: z.string().optional(),
      apiBaseUrl: z.string().url().optional(),
    })
    .optional(),
  telegram: z
    .object({
      botToken: z.string().min(1),
      chatId: z.union([z.string().min(1), z.number()]),
      apiBaseUrl: z.string().url().optional(),
    })
    .optional(),
  pagerduty: z
    .object({
      routingKey: z.string().min(1),
      apiBaseUrl: z.string().url().optional(),
    })
    .optional(),
});

async function postHandler(request: Request) {
  const closed = await setupClosed();
  if (closed) return closed;
  try {
    const session = await requireSession({
      permission: "setup:run",
      requireMfa: false,
    });
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }

    for (const kind of ["ntfy", "pushover", "telegram", "pagerduty"] as const) {
      const cfg = body.data[kind];
      const problem = cfg ? validateChannelConfig(kind, cfg as Record<string, unknown>) : null;
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }

    const blocked = await rejectBlockedUrls([
      body.data.slackWebhookUrl,
      body.data.discordWebhookUrl,
      body.data.sms?.apiBaseUrl,
      body.data.ntfy?.serverUrl,
      body.data.pushover?.apiBaseUrl,
      body.data.telegram?.apiBaseUrl,
      body.data.pagerduty?.apiBaseUrl,
      body.data.smtp ? smtpProbeUrl(body.data.smtp.host, body.data.smtp.port) : null,
    ]);
    if (blocked) return blocked;

    if (body.data.smtp) {
      await upsertAlertChannel({
        orgId: session.orgId!,
        kind: "smtp",
        config: body.data.smtp,
      });
    }

    if (body.data.slackWebhookUrl) {
      await upsertAlertChannel({
        orgId: session.orgId!,
        kind: "slack",
        config: { url: body.data.slackWebhookUrl },
      });
    }

    if (body.data.discordWebhookUrl) {
      await upsertAlertChannel({
        orgId: session.orgId!,
        kind: "discord",
        config: { url: body.data.discordWebhookUrl },
      });
    }

    for (const kind of ["ntfy", "pushover", "telegram", "pagerduty"] as const) {
      const cfg = body.data[kind];
      if (cfg) await upsertAlertChannel({ orgId: session.orgId!, kind, config: cfg });
    }

    if (body.data.sms) {
      await upsertAlertChannel({
        orgId: session.orgId!,
        kind: "sms",
        enabled: true,
        config: {
          provider: "twilio-compatible",
          ...body.data.sms,
        },
      });
    } else {
      // Keep an SMS channel row present but disabled when BYO creds omitted.
      await upsertAlertChannel({
        orgId: session.orgId!,
        kind: "sms",
        enabled: false,
        config: { provider: "twilio-compatible" },
      });
    }

    await recordAudit({
      session,
      request,
      action: "alert_channel.save",
      detail: {
        via: "setup",
        kinds: [
          body.data.smtp ? "smtp" : null,
          body.data.slackWebhookUrl ? "slack" : null,
          body.data.discordWebhookUrl ? "discord" : null,
          body.data.sms ? "sms" : null,
          body.data.ntfy ? "ntfy" : null,
          body.data.pushover ? "pushover" : null,
          body.data.telegram ? "telegram" : null,
          body.data.pagerduty ? "pagerduty" : null,
        ].filter(Boolean),
      },
    });
    await ensureDefaultThresholdRule(session.orgId!);
    await setSetupStep("agent_token");

    return NextResponse.json({ nextStep: "agent_token" });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
