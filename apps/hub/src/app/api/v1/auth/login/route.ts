import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getSession } from "@/lib/auth/session";
import { findUserByLogin } from "@/lib/db/store";
import { readJsonLimited } from "@/lib/http-guard/body";
import { clearLimit, clientIp, limit, presetFor, tooMany } from "@/lib/http-guard/rate-limit";

export const dynamic = "force-dynamic";

// Real bcrypt hash computed once, compared against when the email is unknown
// so response timing matches a wrong-password attempt.
let dummyHash: Promise<string> | undefined;
function getDummyHash() {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

const loginId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      z.string().email().safeParse(value).success ||
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value),
  );

const schema = z.object({
  email: loginId,
  password: z.string().min(1),
});

async function postHandler(request: Request) {
  const raw = await readJsonLimited(request, 8 * 1024);
  const body = schema.safeParse(raw.ok ? raw.value : null);
  if (!body.success) {
    return NextResponse.json({ error: "invalid credentials payload" }, { status: 400 });
  }

  const rl = presetFor("LOGIN");
  const rlKey = `login|${clientIp(request)}|${body.data.email.toLowerCase()}`;
  // Count the attempt before the (slow) password check so parallel bursts cannot all slip
  // past the gate; a success clears the bucket.
  const hit = limit({ key: rlKey, ...rl });
  if (!hit.allowed) return tooMany(hit.retryAfter);

  const user = await findUserByLogin(body.data.email);
  const passwordOk = await verifyPassword(
    body.data.password,
    user ? user.password_hash : await getDummyHash(),
  );
  if (!user || !passwordOk) {
    return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
  }

  clearLimit(rlKey);
  const session = await getSession();
  session.userId = user.id;
  session.orgId = user.org_id;
  session.email = user.email;
  session.role = user.role;
  session.isLoggedIn = true;
  session.sessionVersion = Number(user.session_version ?? 0);
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
