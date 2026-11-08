import { NextResponse } from "next/server";
import { guardBody, guardRate } from "@/lib/http-guard/ingest";
import { ingestOtlpTraces } from "@/lib/otel/traces";
import {
  extractBearerOrHeaderToken,
  findOrgByIntegrationToken,
} from "@/lib/integrations/tokens";

export const dynamic = "force-dynamic";

/**
 * OTLP/HTTP JSON traces receiver (ExportTraceServiceRequest), Phase 29.
 * Collectors must use encoding: json and Authorization: Bearer <otel token>.
 */
export async function POST(request: Request) {
  try {
    const limited = guardRate(request, { name: "INGEST", route: "v1/traces" });
    if (limited) return limited;
    const token = extractBearerOrHeaderToken(request);
    if (!token) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const found = await findOrgByIntegrationToken("otel_ingest", token);
    if (!found) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (
      contentType.includes("protobuf") ||
      contentType.includes("application/x-protobuf")
    ) {
      return NextResponse.json(
        {
          error:
            "protobuf not supported; configure otlphttp encoding: json",
        },
        { status: 415 },
      );
    }

    const guarded = await guardBody(request, { name: "INGEST", route: "v1/traces", maxBytes: 4194304 });
    if (!guarded.ok) return guarded.response;
    const body = guarded.value;
    if (body == null || typeof body !== "object") {
      return NextResponse.json({ error: "invalid json body" }, { status: 400 });
    }

    const result = await ingestOtlpTraces({
      orgId: found.orgId,
      body,
    });

    return NextResponse.json({
      partialSuccess:
        result.rejected > 0
          ? {
              rejectedSpans: result.rejected,
              errorMessage: "span limit per request exceeded",
            }
          : {},
      accepted: result.accepted,
    });
  } catch (err) {
    console.error("[heimdall] otlp traces failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
