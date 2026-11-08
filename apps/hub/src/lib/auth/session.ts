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
  /** users.session_version at sign-in; a bump (logout) revokes every older cookie. */
  sessionVersion?: number;
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

/** Session lifetime. Cookies older than this are rejected by iron-session. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const DEV_FALLBACK = "CHANGE_ME_SESSION_SECRET_REPLACE_BEFORE_USE!!";
/** Values that have appeared in shipped files. Never valid outside dev/test. */
const PUBLISHED_SECRETS = new Set([
  DEV_FALLBACK,
  "CHANGE_ME_SESSION_SECRET_REPLACE_BEFORE_USE!!",
  "at-least-32-chars-secret!!!!!!!!!!!!",
]);

function sessionPassword(): string {
  const secret = process.env.HEIMDALL_SESSION_SECRET;
  const production = process.env.NODE_ENV === "production";
  if (secret && secret.length >= 32) {
    if (production && PUBLISHED_SECRETS.has(secret)) {
      throw new Error(
        "HEIMDALL_SESSION_SECRET is a published example value; set a random one (openssl rand -hex 32)",
      );
    }
    return secret;
  }
  if (production) {
    throw new Error(
      "HEIMDALL_SESSION_SECRET must be set to at least 32 characters in production",
    );
  }
  // Dev/test fallback — never used when NODE_ENV=production.
  return DEV_FALLBACK;
}

export function sessionOptions(): SessionOptions {
  return {
    password: sessionPassword(),
    cookieName: "heimdall_session",
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      secure: cookieSecure(),
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
  };
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/**
 * Re-check a signed-in cookie against the database. The cookie is only trusted for the
 * identity it names: a deleted user, an org move or a bumped session_version logs it out,
 * and a demotion takes effect at once (the lower of cookie and DB role wins).
 */
async function revalidate(session: Partial<SessionData>) {
  if (!session.isLoggedIn || !session.userId) return;
  const { findUserById } = await import("@/lib/db/store");
  const user = await findUserById(session.userId);
  const version = Number(user?.session_version ?? 0);
  if (!user || user.org_id !== session.orgId || version !== Number(session.sessionVersion ?? 0)) {
    session.isLoggedIn = false;
    session.userId = undefined;
    session.orgId = undefined;
    session.role = undefined;
    session.mfaVerified = false;
    return;
  }
  if (session.role && RANK[user.role] < RANK[session.role]) session.role = user.role;
}

export async function getSession() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions());
  await revalidate(session);
  return session;
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
