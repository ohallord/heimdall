import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { findUserById } from "@/lib/db/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  const user = await findUserById(session.userId);
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    mfaVerified: Boolean(session.mfaVerified),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mfaEnrolled: user.mfa_enrolled,
      orgId: user.org_id,
    },
  });
}
