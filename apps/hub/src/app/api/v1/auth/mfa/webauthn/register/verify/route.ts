import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { takeChallenge } from "@/lib/auth/challenge-store";
import { getSession } from "@/lib/auth/session";
import {
  findUserById,
  markMfaEnrolled,
  replaceRecoveryCodes,
  saveWebAuthnCredential,
} from "@/lib/db/store";
import { verifyRegistration } from "@/lib/mfa/webauthn";

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
  if (user.mfa_enrolled && !session.mfaVerified) {
    return NextResponse.json({ error: "mfa_required" }, { status: 403 });
  }

  const expectedChallenge = takeChallenge(session.userId);
  if (!expectedChallenge) {
    return NextResponse.json({ error: "missing challenge" }, { status: 400 });
  }

  const response = (await request.json()) as RegistrationResponseJSON;
  const verification = await verifyRegistration({
    response,
    expectedChallenge,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "verification failed" }, { status: 400 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  await saveWebAuthnCredential({
    userId: session.userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports,
  });

  await markMfaEnrolled(session.userId);
  const recoveryCodes = await replaceRecoveryCodes(session.userId);
  session.mfaVerified = true;
  await session.save();

  return NextResponse.json({
    verified: true,
    recoveryCodes,
    meta: { credentialDeviceType, credentialBackedUp },
  });
}

export const POST = mutating(postHandler);
