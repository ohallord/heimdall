import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { putChallenge } from "@/lib/auth/challenge-store";
import { getSession } from "@/lib/auth/session";
import { findUserById, listWebAuthnCredentials } from "@/lib/db/store";
import { createRegistrationOptions } from "@/lib/mfa/webauthn";

export const dynamic = "force-dynamic";

async function postHandler() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId || session.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await findUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  if (user.mfa_enrolled && !session.mfaVerified) {
    return NextResponse.json({ error: "mfa_required" }, { status: 403 });
  }

  const existing = await listWebAuthnCredentials(user.id);
  const options = await createRegistrationOptions({
    userId: user.id,
    email: user.email,
    existingCredentialIds: existing.map((c) => c.credential_id),
  });
  putChallenge(user.id, options.challenge);
  return NextResponse.json(options);
}

export const POST = mutating(postHandler);
