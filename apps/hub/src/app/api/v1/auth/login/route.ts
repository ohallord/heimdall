import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getSession } from "@/lib/auth/session";
import { findUserByEmail } from "@/lib/db/store";
import { clearLimit, clientIp, isBlocked, limit, presetFor, tooMany } from "@/lib/http-guard/rate-limit";

export const dynamic = "force-dynamic";

// Real bcrypt hash computed once, compared against when the email is unknown
// so response timing matches a wrong-password attempt.
let dummyHash: Promise<string> | undefined;
function getDummyHash() {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function postHandler(request: Request) {
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "invalid credentials payload" }, { status: 400 });
  }

  const rl = presetFor("LOGIN");
  const rlKey = `login|${clientIp(request)}|${body.data.email.toLowerCase()}`;
  const gate = isBlocked({ key: rlKey, max: rl.max });
  if (gate.blocked) return tooMany(gate.retryAfter);

  const user = await findUserByEmail(body.data.email);
  const passwordOk = await verifyPassword(
    body.data.password,
    user ? user.password_hash : await getDummyHash(),
  );
  if (!user || !passwordOk) {
    limit({ key: rlKey, ...rl });
    return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
  }

  clearLimit(rlKey);
  const session = await getSession();
  session.userId = user.id;
  session.orgId = user.org_id;
  session.email = user.email;
  session.role = user.role;
  session.isLoggedIn = true;
  // Admins with MFA enrolled must verify MFA next.
  if (user.role === "admin" && user.mfa_enrolled) {
    session.mfaVerified = false;
  } else {
    session.mfaVerified = true;
  }
  await session.save();

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      mfaEnrolled: user.mfa_enrolled,
    },
    mfaRequired: user.role === "admin" && user.mfa_enrolled,
  });
}

export const POST = mutating(postHandler);
