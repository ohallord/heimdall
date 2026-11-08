import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { bumpSessionVersion } from "@/lib/db/store";

export const dynamic = "force-dynamic";

async function postHandler() {
  const session = await getSession();
  // Server-side revoke: a copied or stolen cookie stops working too.
  if (session.isLoggedIn && session.userId) await bumpSessionVersion(session.userId);
  session.destroy();
  return NextResponse.json({ ok: true });
}

export const POST = mutating(postHandler);
