import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  findUserById,
  markMfaEnrolled,
  promoteTotpPending,
  replaceRecoveryCodes,
  setUserTotpPending,
} from "@/lib/db/store";
import { generateTotpSecret, verifyTotp } from "@/lib/mfa/totp";

export const dynamic = "force-dynamic";

async function postHandler(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId || session.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await findUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // Replacing an existing factor requires a verified MFA session.
  if (user.mfa_enrolled && !session.mfaVerified) {
    return NextResponse.json({ error: "mfa_required" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    token?: string;
  };

  if (body.action === "start") {
    const { secret, uri } = generateTotpSecret(user.email);
    // Held pending; the active totp_secret is untouched until confirm.
    await setUserTotpPending(user.id, secret);
    return NextResponse.json({ secret, uri });
  }

  if (body.action === "confirm") {
    if (!user.totp_pending || !body.token) {
      return NextResponse.json(
        { error: "token required; start enrollment first" },
        { status: 400 },
      );
    }
    if (!verifyTotp(user.totp_pending, body.token)) {
      return NextResponse.json(
        { error: "invalid authenticator code" },
        { status: 400 },
      );
    }
    if (!(await promoteTotpPending(user.id))) {
      return NextResponse.json({ error: "no pending enrollment" }, { status: 409 });
    }
    await markMfaEnrolled(user.id);
    const recoveryCodes = await replaceRecoveryCodes(user.id);
    session.mfaVerified = true;
    await session.save();
    return NextResponse.json({ enrolled: true, recoveryCodes });
  }

  return NextResponse.json({ error: "action must be start or confirm" }, { status: 400 });
}

export const POST = mutating(postHandler);
