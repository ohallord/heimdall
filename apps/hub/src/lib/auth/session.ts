import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { cookieSecure } from "@/lib/auth/cookie-secure";
import type { Role } from "@/lib/db/types";

export type SessionData = {
  userId?: string;
  orgId?: string;
  email?: string;
  role?: Role;
  mfaVerified?: boolean;
  isLoggedIn: boolean;
  /** Transient OIDC authorization state (cleared after callback). */
  oidcState?: string;
  oidcNonce?: string;
  oidcCodeVerifier?: string;
  oidcProviderId?: string;
};

export const defaultSession: SessionData = {
  isLoggedIn: false,
  mfaVerified: false,
};

function sessionPassword(): string {
  const secret = process.env.HEIMDALL_SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "HEIMDALL_SESSION_SECRET must be set to at least 32 characters in production",
    );
  }
  // Dev/test fallback — never used when NODE_ENV=production.
  return "heimdall-dev-session-secret-change-me!!";
}

export function sessionOptions(): SessionOptions {
  return {
    password: sessionPassword(),
    cookieName: "heimdall_session",
    cookieOptions: {
      secure: cookieSecure(),
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

export async function requireSession(opts?: {
  permission?: import("@/lib/rbac/permissions").Permission;
  requireMfa?: boolean;
}) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId || !session.role || !session.orgId) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  if (opts?.requireMfa !== false && session.role === "admin" && !session.mfaVerified) {
    throw Object.assign(new Error("mfa_required"), { status: 403 });
  }
  if (opts?.permission) {
    const { can } = await import("@/lib/rbac/permissions");
    if (!can(session.role, opts.permission)) {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    }
  }
  return session;
}
