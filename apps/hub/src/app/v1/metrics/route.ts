import { NextResponse } from "next/server";
import { guardBody, guardRate } from "@/lib/http-guard/ingest";
import { ingestOtlpMetrics } from "@/lib/otel/ingest";
import {
  extractBearerOrHeaderToken,
  findOrgByIntegrationToken,
} from "@/lib/integrations/tokens";

export const dynamic = "force-dynamic";

/**
 * OTLP/HTTP JSON metrics receiver (ExportMetricsServiceRequest).
 * Collectors must use encoding: json and Authorization: Bearer <otel token>.
 */
export async function POST(request: Request) {
  try {
    const limited = guardRate(request, { name: "INGEST", route: "v1/metrics" });
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

    const guarded = await guardBody(request, { name: "INGEST", route: "v1/metrics", maxBytes: 4194304 });
    if (!guarded.ok) return guarded.response;
    const body = guarded.value;
    if (body == null || typeof body !== "object") {
      return NextResponse.json({ error: "invalid json body" }, { status: 400 });
    }

    const result = await ingestOtlpMetrics({
      orgId: found.orgId,
      body,
    });

    return NextResponse.json({
      partialSuccess: {},
      accepted: result.accepted,
      mirroredHosts: result.mirroredHosts,
    });
  } catch (err) {
    console.error("[heimdall] otlp metrics failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
