import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { smtpProbeUrl } from "@/lib/alerts/channels";
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

    const blocked = await rejectBlockedUrls([
      body.data.slackWebhookUrl,
      body.data.discordWebhookUrl,
      body.data.sms?.apiBaseUrl,
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

    await ensureDefaultThresholdRule(session.orgId!);
    await setSetupStep("agent_token");

    return NextResponse.json({ nextStep: "agent_token" });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
