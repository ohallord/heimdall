import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { setupClosed } from "@/lib/auth/setup-guard";
import { requireSession } from "@/lib/auth/session";
import { findUserById, markSetupComplete } from "@/lib/db/store";

export const dynamic = "force-dynamic";

async function postHandler() {
  const closed = await setupClosed();
  if (closed) return closed;
  try {
    const session = await requireSession({
      permission: "setup:run",
      requireMfa: false,
    });
    const user = await findUserById(session.userId!);
    if (!user) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    if (user.role === "admin" && !user.mfa_enrolled) {
      return NextResponse.json(
        { error: "admin MFA enrollment required before completing setup" },
        { status: 400 },
      );
    }

    await markSetupComplete(session.orgId!);
    return NextResponse.json({ complete: true, next: "/dashboard" });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
