import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validatePasswordStrength } from "@/lib/auth/password";
import { getSession } from "@/lib/auth/session";
import { createOrgAndAdmin, isSetupComplete } from "@/lib/db/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  orgName: z.string().trim().min(2).max(80),
  adminName: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  password: z.string().min(10).max(200),
});

async function postHandler(request: Request) {
  if (await isSetupComplete()) {
    return NextResponse.json({ error: "setup already complete" }, { status: 409 });
  }

  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  const strength = validatePasswordStrength(body.data.password);
  if (strength) {
    return NextResponse.json({ error: strength }, { status: 400 });
  }

  const { org, user } = await createOrgAndAdmin(body.data);
  const session = await getSession();
  session.userId = user.id;
  session.orgId = org.id;
  session.email = user.email;
  session.role = user.role;
  session.mfaVerified = false;
  session.isLoggedIn = true;
  await session.save();

  return NextResponse.json({
    org: { id: org.id, name: org.name },
    user: { id: user.id, email: user.email, role: user.role },
    nextStep: "channels",
  });
}

export const POST = mutating(postHandler);
