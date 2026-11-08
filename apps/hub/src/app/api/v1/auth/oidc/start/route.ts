import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { getSession } from "@/lib/auth/session";
import {
  buildAuthorizationUrl,
  discoverOidc,
  generatePkce,
} from "@/lib/oidc/client";
import { getOidcProvider } from "@/lib/oidc/store";
import { newId } from "@/lib/ids";

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
  try {
    const url = new URL(request.url);
    const providerId = url.searchParams.get("provider");
    if (!providerId) {
      return NextResponse.json({ error: "provider required" }, { status: 400 });
    }
    const provider = await getOidcProvider(providerId);
    if (!provider || !provider.enabled) {
      return NextResponse.json({ error: "provider not found" }, { status: 404 });
    }

    const discovery = await discoverOidc(provider.issuer);
    const state = newId("oidcstate");
    const nonce = newId("oidcnonce");
    const pkce = generatePkce();
    const redirectUri = `${publicBase(request)}/api/v1/auth/oidc/callback`;

    const session = await getSession();
    session.oidcState = state;
    session.oidcNonce = nonce;
    session.oidcCodeVerifier = pkce.verifier;
    session.oidcProviderId = provider.id;
    await session.save();

    const authUrl = buildAuthorizationUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: provider.client_id,
      redirectUri,
      scope: provider.scopes,
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    return NextResponse.redirect(authUrl);
  } catch (err) {
    return apiError(err);
  }
}
