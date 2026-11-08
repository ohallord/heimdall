import { NextResponse } from "next/server";
import { guardBody, guardRate } from "@/lib/http-guard/ingest";
import { ingestRuntimeWebhook } from "@/lib/integrations/runtime/ingest";
import {
  extractBearerOrHeaderToken,
  findOrgByIntegrationToken,
} from "@/lib/integrations/tokens";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const limited = guardRate(request, { name: "WEBHOOK", route: "webhook/runtime" });
    if (limited) return limited;
    const token = extractBearerOrHeaderToken(request);
    if (!token) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const found = await findOrgByIntegrationToken("runtime_webhook", token);
    if (!found) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const guarded = await guardBody(request, { name: "WEBHOOK", route: "webhook/runtime", maxBytes: 1048576 });
    if (!guarded.ok) return guarded.response;
    const body = guarded.value;
    if (body == null || (typeof body !== "object" && !Array.isArray(body))) {
      return NextResponse.json({ error: "invalid json body" }, { status: 400 });
    }

    const result = await ingestRuntimeWebhook({
      orgId: found.orgId,
      body,
    });
    return NextResponse.json({
      ok: true,
      accepted: result.accepted,
      written: result.written,
      alarmsRaised: result.alarmsRaised,
    });
  } catch (err) {
    console.error("[heimdall] runtime webhook failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
