import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { getSession } from "@/lib/auth/session";
import {
  OidcError,
  discoverOidc,
  exchangeCode,
  fetchUserInfo,
  verifyIdToken,
} from "@/lib/oidc/client";
import { findOrCreateOidcUser, getOidcProvider } from "@/lib/oidc/store";

export const dynamic = "force-dynamic";

function publicBase(request: Request): string {
  const env = process.env.HEIMDALL_PUBLIC_URL?.replace(/\/$/, "");
  if (env) return env;
  // The Host header is client-controlled; in production the redirect_uri must come from config.
  if (process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("set HEIMDALL_PUBLIC_URL to use single sign-on"), { status: 503 });
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET(request: Request) {
  let base: string;
  try {
    base = publicBase(request);
  } catch (err) {
    return apiError(err);
  }
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errParam = url.searchParams.get("error");
    if (errParam) {
      return NextResponse.redirect(
        `${base}/login?error=${encodeURIComponent(errParam)}`,
      );
    }
    if (!code || !state) {
      return NextResponse.redirect(`${base}/login?error=missing_code`);
    }

    const session = await getSession();
    if (!session.oidcState || session.oidcState !== state || !session.oidcProviderId) {
      return NextResponse.redirect(`${base}/login?error=invalid_state`);
    }

    const provider = await getOidcProvider(session.oidcProviderId);
    if (!provider || !provider.enabled) {
      return NextResponse.redirect(`${base}/login?error=provider_missing`);
    }

    // State, nonce and verifier are single-use.
    const nonce = session.oidcNonce;
    const codeVerifier = session.oidcCodeVerifier;
    session.oidcState = undefined;
    session.oidcNonce = undefined;
    session.oidcCodeVerifier = undefined;
    session.oidcProviderId = undefined;
    await session.save();
    if (!nonce || !codeVerifier) {
      return NextResponse.redirect(`${base}/login?error=invalid_state`);
    }

    const discovery = await discoverOidc(provider.issuer);
    const redirectUri = `${base}/api/v1/auth/oidc/callback`;
    const tokens = await exchangeCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: provider.client_id,
      clientSecret: provider.client_secret,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokens.id_token || !discovery.jwks_uri) {
      return NextResponse.redirect(`${base}/login?error=invalid_id_token`);
    }
    const claims = await verifyIdToken({
      idToken: tokens.id_token,
      jwksUri: discovery.jwks_uri,
      issuer: provider.issuer,
      clientId: provider.client_id,
      nonce,
    });
    if (claims.email_verified === false) {
      return NextResponse.redirect(`${base}/login?error=email_not_verified`);
    }

    const sub = claims.sub;
    let email = claims.email;
    let emailVerified = claims.email ? claims.email_verified === true : false;
    let name = claims.name ?? claims.preferred_username;

    if (discovery.userinfo_endpoint && tokens.access_token) {
      try {
        const info = await fetchUserInfo({
          userinfoEndpoint: discovery.userinfo_endpoint,
          accessToken: tokens.access_token,
        });
        if (info.sub !== sub) {
          return NextResponse.redirect(`${base}/login?error=sub_mismatch`);
        }
        if (!email && info.email) {
          email = info.email;
          emailVerified = info.email_verified === true;
        }
        name = name ?? info.name ?? info.preferred_username;
      } catch {
        /* userinfo is optional; verified id_token claims suffice */
      }
    }

    if (!email) {
      return NextResponse.redirect(`${base}/login?error=missing_claims`);
    }

    const user = await findOrCreateOidcUser({
      orgId: provider.org_id,
      providerId: provider.id,
      sub,
      email,
      emailVerified,
      name: name ?? email,
    });

    session.userId = user.id;
    session.orgId = user.org_id;
    session.email = user.email;
    session.role = user.role;
    session.isLoggedIn = true;
    session.sessionVersion = Number(user.session_version ?? 0);
    // OIDC users skip local MFA on this path; admins who also enrolled MFA still enforce it.
    if (user.role === "admin" && user.mfa_enrolled) {
      session.mfaVerified = false;
      await session.save();
      return NextResponse.redirect(`${base}/login?mfa=1`);
    }
    session.mfaVerified = true;
    await session.save();
    return NextResponse.redirect(`${base}/dashboard`);
  } catch (err) {
    // Only our own error codes reach the URL; IdP/driver text stays in the server log.
    if (!(err instanceof OidcError)) console.error("[heimdall] oidc callback failed:", err);
    const msg = err instanceof OidcError ? err.code : "oidc_failed";
    return NextResponse.redirect(
      `${base}/login?error=${encodeURIComponent(msg.slice(0, 80))}`,
    );
  }
}
