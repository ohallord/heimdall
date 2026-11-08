import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ingestSecurityScan } from "@/lib/security/sync";

export const dynamic = "force-dynamic";

const schema = z.object({
  trivyReport: z.unknown().optional(),
  osvReport: z.unknown().optional(),
  syncRemotes: z.boolean().optional().default(false),
});

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    if (
      body.data.trivyReport == null &&
      body.data.osvReport == null &&
      !body.data.syncRemotes
    ) {
      return NextResponse.json(
        { error: "provide trivyReport, osvReport, and/or syncRemotes" },
        { status: 400 },
      );
    }

    const result = await ingestSecurityScan({
      orgId: session.orgId!,
      trivyReport: body.data.trivyReport,
      osvReport: body.data.osvReport,
      syncRemotes: body.data.syncRemotes,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
