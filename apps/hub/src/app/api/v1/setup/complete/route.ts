import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { findUserById, markSetupComplete } from "@/lib/db/store";

export const dynamic = "force-dynamic";

async function postHandler() {
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
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const POST = mutating(postHandler);
