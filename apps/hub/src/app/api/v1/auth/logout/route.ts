import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

async function postHandler() {
  const session = await getSession();
  session.destroy();
  return NextResponse.json({ ok: true });
}

export const POST = mutating(postHandler);
