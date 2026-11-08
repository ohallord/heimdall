import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { requireSession } from "@/lib/auth/session";
import {
  ensureIntegrationToken,
  getIntegrationToken,
  rotateIntegrationToken,
} from "@/lib/integrations/tokens";

export const dynamic = "force-dynamic";

const WEBHOOK_PATH = "/api/v1/integrations/runtime/webhook";

export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const orgId = session.orgId!;
    let row = await getIntegrationToken(orgId, "runtime_webhook");
    let minted: string | null = null;
    if (!row) {
      const ensured = await ensureIntegrationToken({
        orgId,
        kind: "runtime_webhook",
      });
      row = ensured.row;
      minted = ensured.token;
    }
    return NextResponse.json({
      webhookPath: WEBHOOK_PATH,
      tokenHint: row.token_hint,
      createdAt: row.created_at,
      ...(minted ? { token: minted } : {}),
    });
  } catch (err) {
    return apiError(err);
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
      kind: "runtime_webhook",
    });
    return NextResponse.json({
      webhookPath: WEBHOOK_PATH,
      tokenHint: row.token_hint,
      createdAt: row.created_at,
      token,
    });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
