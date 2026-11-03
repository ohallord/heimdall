import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { guardedFetch } from "@/lib/http-guard/safe-fetch";

export class OidcError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "OidcError";
  }
}

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
};

export type OidcTokenResponse = {
  access_token: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

export type OidcUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
};

export type VerifiedIdToken = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
};

export async function discoverOidc(
  issuer: string,
  fetchImpl: typeof fetch = guardedFetch,
): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/$/, "");
  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`oidc discovery ${res.status}`);
  }
  const doc = (await res.json()) as OidcDiscovery;
  if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/$/, "") !== base) {
    throw new OidcError("issuer_mismatch");
  }
  return doc;
}

/** PKCE S256 verifier + challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<OidcTokenResponse> {
  const fetchFn = input.fetchImpl ?? guardedFetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const res = await fetchFn(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`oidc token ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OidcTokenResponse;
}

export async function fetchUserInfo(input: {
  userinfoEndpoint: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<OidcUserInfo> {
  const fetchFn = input.fetchImpl ?? guardedFetch;
  const res = await fetchFn(input.userinfoEndpoint, {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`oidc userinfo ${res.status}`);
  }
  return (await res.json()) as OidcUserInfo;
}

/**
 * Verify an id_token: signature (provider JWKS), iss, aud, exp (60s skew), nonce.
 * Throws OidcError("invalid_id_token") on any failure.
 */
export async function verifyIdToken(input: {
  idToken: string;
  jwksUri: string;
  issuer: string;
  clientId: string;
  nonce: string;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedIdToken> {
  try {
    if (!input.nonce) throw new Error("no session nonce");
    const fetchFn = input.fetchImpl ?? guardedFetch;
    const res = await fetchFn(input.jwksUri);
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const jwks = createLocalJWKSet((await res.json()) as JSONWebKeySet);
    const { payload } = await jwtVerify(input.idToken, jwks, {
      issuer: [
        input.issuer.replace(/\/$/, ""),
        input.issuer.replace(/\/$/, "") + "/",
      ],
      audience: input.clientId,
      algorithms: ["RS256", "ES256", "PS256"],
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "iss", "aud", "nonce"],
    });
    if (payload.nonce !== input.nonce) throw new Error("nonce mismatch");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no sub");
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      sub: payload.sub,
      email: str(payload.email),
      email_verified:
        typeof payload.email_verified === "boolean"
          ? payload.email_verified
          : undefined,
      name: str(payload.name),
      preferred_username: str(payload.preferred_username),
    };
  } catch {
    throw new OidcError("invalid_id_token");
  }
}
