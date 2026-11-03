import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  ensureIntegrationToken,
  getIntegrationToken,
  rotateIntegrationToken,
} from "@/lib/integrations/tokens";

export const dynamic = "force-dynamic";

const METRICS_PATH = "/v1/metrics";
const LOGS_PATH = "/v1/logs";
const TRACES_PATH = "/v1/traces";

export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const orgId = session.orgId!;
    let row = await getIntegrationToken(orgId, "otel_ingest");
    let minted: string | null = null;
    if (!row) {
      const ensured = await ensureIntegrationToken({
        orgId,
        kind: "otel_ingest",
      });
      row = ensured.row;
      minted = ensured.token;
    }
    return NextResponse.json({
      metricsPath: METRICS_PATH,
      logsPath: LOGS_PATH,
      tracesPath: TRACES_PATH,
      tokenHint: row.token_hint,
      createdAt: row.created_at,
      ...(minted ? { token: minted } : {}),
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const body = (await request.json().catch(() => ({}))) as {
      rotate?: boolean;
    };
    if (!body.rotate) {
      return NextResponse.json(
        { error: "pass { rotate: true } to mint a new token" },
        { status: 400 },
      );
    }
    const { row, token } = await rotateIntegrationToken({
      orgId: session.orgId!,
      kind: "otel_ingest",
    });
    return NextResponse.json({
      metricsPath: METRICS_PATH,
      logsPath: LOGS_PATH,
      tracesPath: TRACES_PATH,
      tokenHint: row.token_hint,
      createdAt: row.created_at,
      token,
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const POST = mutating(postHandler);
