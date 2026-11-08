import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validatePasswordStrength } from "@/lib/auth/password";
import { getSession } from "@/lib/auth/session";
import { matchesBootstrapToken } from "@/lib/agents/bootstrap";
import { readJsonLimited } from "@/lib/http-guard/body";
import { clientIp, limit, presetFor, tooMany } from "@/lib/http-guard/rate-limit";
import {
  claimFirstAdminStep,
  createOrgAndAdmin,
  isSetupComplete,
  releaseFirstAdminStep,
} from "@/lib/db/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  orgName: z.string().trim().min(2).max(80),
  adminName: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  password: z.string().min(10).max(200),
  // The hub's bootstrap token. Without it, whoever reaches a fresh hub first owns it.
  setupToken: z.string().min(1).max(512),
});

async function postHandler(request: Request) {
  if (await isSetupComplete()) {
    return NextResponse.json({ error: "setup already complete" }, { status: 409 });
  }

  const rl = presetFor("LOGIN");
  const hit = limit({ key: `setup|${clientIp(request)}`, ...rl });
  if (!hit.allowed) return tooMany(hit.retryAfter);

  const raw = await readJsonLimited(request, 16 * 1024);
  if (!raw.ok) return NextResponse.json({ error: "invalid body" }, { status: raw.status });
  const body = schema.safeParse(raw.value);
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  if (!(await matchesBootstrapToken(body.data.setupToken))) {
    return NextResponse.json(
      { error: "setup token does not match HEIMDALL_BOOTSTRAP_TOKEN" },
      { status: 403 },
    );
  }

  const strength = validatePasswordStrength(body.data.password);
  if (strength) {
    return NextResponse.json({ error: strength }, { status: 400 });
  }

  if (!(await claimFirstAdminStep())) {
    return NextResponse.json(
      { error: "an admin already exists; sign in to continue setup" },
      { status: 409 },
    );
  }

  let created: Awaited<ReturnType<typeof createOrgAndAdmin>>;
  try {
    created = await createOrgAndAdmin(body.data);
  } catch (err) {
    await releaseFirstAdminStep();
    throw err;
  }
  const { org, user } = created;
  const session = await getSession();
  session.userId = user.id;
  session.orgId = org.id;
  session.email = user.email;
  session.role = user.role;
  session.mfaVerified = false;
  session.isLoggedIn = true;
  session.sessionVersion = Number(user.session_version ?? 0);
  await session.save();

  return NextResponse.json({
    org: { id: org.id, name: org.name },
    user: { id: user.id, email: user.email, role: user.role },
    nextStep: "channels",
  });
}

export const POST = mutating(postHandler);
