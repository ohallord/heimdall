import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { consumeRecoveryCode, findUserById } from "@/lib/db/store";
import { verifyTotp } from "@/lib/mfa/totp";
import { clearLimit, isBlocked, limit, presetFor, tooMany } from "@/lib/http-guard/rate-limit";

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
  const gate = isBlocked({ key: rlKey, max: rl.max });
  if (gate.blocked) return tooMany(gate.retryAfter);

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
    ok = verifyTotp(user.totp_secret, body.data.code);
  } else {
    ok = await consumeRecoveryCode(user.id, body.data.code);
  }

  if (!ok) {
    limit({ key: rlKey, ...rl });
    return NextResponse.json({ error: "invalid code" }, { status: 401 });
  }

  clearLimit(rlKey);
  session.mfaVerified = true;
  await session.save();
  return NextResponse.json({ verified: true });
}

export const POST = mutating(postHandler);
