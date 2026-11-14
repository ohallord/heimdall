import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { apiError } from "@/lib/http-guard/api-error";
import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, listAudit } from "@/lib/audit/log";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/audit?action=&limit=&cursor= — newest-first audit entries for the org.
 * Admin only (settings:write). `nextCursor` is null on the last page.
 */
export async function GET(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? AUDIT_PAGE_DEFAULT);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(AUDIT_PAGE_MAX, Math.max(1, Math.floor(limitRaw)))
      : AUDIT_PAGE_DEFAULT;
    const action = url.searchParams.get("action")?.trim().slice(0, 80) || undefined;
    const cursor = url.searchParams.get("cursor") || undefined;
    const { rows, nextCursor } = await listAudit(session.orgId!, { action, limit, cursor });
    return NextResponse.json({ entries: rows, nextCursor });
  } catch (err) {
    return apiError(err);
  }
}
