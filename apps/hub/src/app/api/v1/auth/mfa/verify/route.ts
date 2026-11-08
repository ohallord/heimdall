import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { claimTotpStep, consumeRecoveryCode, findUserById } from "@/lib/db/store";
import { totpStep } from "@/lib/mfa/totp";
import { clearLimit, limit, presetFor, tooMany } from "@/lib/http-guard/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({
  method: z.enum(["totp", "recovery"]),
  code: z.string().min(1),
});

async function postHandler(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const rl = presetFor("MFA");
  const rlKey = `mfa|${session.userId}`;
  // Count before verifying: a burst of parallel guesses all lands in the bucket.
  const hit = limit({ key: rlKey, ...rl });
  if (!hit.allowed) return tooMany(hit.retryAfter);

  const user = await findUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let ok = false;
  if (body.data.method === "totp") {
    if (!user.totp_secret) {
      return NextResponse.json(
        { error: "authenticator not enrolled" },
        { status: 400 },
      );
    }
    const step = totpStep(user.totp_secret, body.data.code);
    // A code is good for one sign-in: reject a replay of this step or an older one.
    ok = step !== null && (await claimTotpStep(user.id, step));
  } else {
    ok = await consumeRecoveryCode(user.id, body.data.code);
  }

  if (!ok) {
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  clearLimit(rlKey);
  session.mfaVerified = true;
  await session.save();
  return NextResponse.json({ verified: true });
}

export const POST = mutating(postHandler);
