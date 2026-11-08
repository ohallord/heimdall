import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { getSession, requireSession } from "@/lib/auth/session";
import { rejectBlockedUrls } from "@/lib/http-guard/validate-url";
import {
  listOidcProviders,
  upsertOidcProvider,
} from "@/lib/oidc/store";
import { isSetupComplete } from "@/lib/db/store";

export const dynamic = "force-dynamic";

const upsertSchema = z.object({
  name: z.string().min(1).max(64),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.string().optional(),
  enabled: z.boolean().optional(),
});

/** Public list for the login page (id + name only). Admins get full metadata. */
export async function GET() {
  try {
    if (!(await isSetupComplete())) {
      return NextResponse.json({ providers: [] });
    }
    const session = await getSession();
    const isAdmin =
      session.isLoggedIn &&
      session.role === "admin" &&
      session.mfaVerified &&
      Boolean(session.orgId);

    if (isAdmin) {
      const rows = await listOidcProviders(session.orgId!);
      return NextResponse.json({
        providers: rows.map((p) => ({
          id: p.id,
          name: p.name,
          issuer: p.issuer,
          clientId: p.client_id,
          scopes: p.scopes,
          enabled: p.enabled,
        })),
      });
    }

    const rows = await listOidcProviders();
    return NextResponse.json({
      providers: rows
        .filter((p) => p.enabled)
        .map((p) => ({ id: p.id, name: p.name })),
    });
  } catch (err) {
    return apiError(err);
  }
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const body = upsertSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const blocked = await rejectBlockedUrls([body.data.issuer]);
    if (blocked) return blocked;
    const row = await upsertOidcProvider({
      orgId: session.orgId!,
      name: body.data.name,
      issuer: body.data.issuer,
      clientId: body.data.clientId,
      clientSecret: body.data.clientSecret,
      scopes: body.data.scopes,
      enabled: body.data.enabled,
    });
    return NextResponse.json({
      provider: {
        id: row.id,
        name: row.name,
        issuer: row.issuer,
        clientId: row.client_id,
        scopes: row.scopes,
        enabled: row.enabled,
      },
    });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
