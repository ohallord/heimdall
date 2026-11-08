import { NextResponse } from "next/server";
import { guardBody, guardRate } from "@/lib/http-guard/ingest";
import { ingestUnifiWebhook } from "@/lib/integrations/unifi/ingest";
import {
  extractBearerOrHeaderToken,
  findOrgByIntegrationToken,
} from "@/lib/integrations/tokens";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const limited = guardRate(request, { name: "WEBHOOK", route: "webhook/unifi" });
    if (limited) return limited;
    const token = extractBearerOrHeaderToken(request);
    if (!token) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const found = await findOrgByIntegrationToken("unifi_webhook", token);
    if (!found) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const guarded = await guardBody(request, { name: "WEBHOOK", route: "webhook/unifi", maxBytes: 1048576 });
    if (!guarded.ok) return guarded.response;
    const body = guarded.value;
    if (body == null || typeof body !== "object") {
      return NextResponse.json({ error: "invalid json body" }, { status: 400 });
    }

    const result = await ingestUnifiWebhook({
      orgId: found.orgId,
      body,
    });
    return NextResponse.json({
      ok: true,
      eventId: result.eventId,
      severity: result.severity,
      notified: result.notified,
    });
  } catch (err) {
    console.error("[heimdall] unifi webhook failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
