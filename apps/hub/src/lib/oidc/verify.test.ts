import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  discoverOidc,
  exchangeCode,
  generatePkce,
  verifyIdToken,
} from "./client";

const ISS = "https://idp.test/realms/heimdall";
const AUD = "heimdall";
const NONCE = "nonce-1";
const JWKS_URI = `${ISS}/certs`;

let good: CryptoKeyPair;
let jwksFetch: typeof fetch;

async function sign(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {},
) {
  return new SignJWT({ nonce: NONCE, email: "a@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("user-1")
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? good.privateKey);
}

const verify = (idToken: string, nonce = NONCE) =>
  verifyIdToken({
    idToken,
    jwksUri: JWKS_URI,
    issuer: ISS,
    clientId: AUD,
    nonce,
    fetchImpl: jwksFetch,
  });

beforeAll(async () => {
  good = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwksFetch = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
});

describe("verifyIdToken", () => {
  it("accepts a valid token", async () => {
    const v = await verify(await sign({}));
    expect(v).toMatchObject({ sub: "user-1", email: "a@example.com" });
  });
  it("rejects bad signature", async () => {
    const other = await generateKeyPair("RS256");
    await expect(verify(await sign({}, { key: other.privateKey }))).rejects.toThrow("invalid_id_token");
  });
  it("rejects wrong audience", async () => {
    await expect(verify(await sign({}, { aud: "other" }))).rejects.toThrow("invalid_id_token");
  });
  it("rejects wrong issuer", async () => {
    await expect(verify(await sign({}, { iss: "https://evil.test" }))).rejects.toThrow("invalid_id_token");
  });
  it("rejects expired (beyond 60s skew)", async () => {
    const exp = Math.floor(Date.now() / 1000) - 120;
    await expect(verify(await sign({}, { exp }))).rejects.toThrow("invalid_id_token");
  });
  it("rejects nonce mismatch and missing nonce", async () => {
    await expect(verify(await sign({}), "different")).rejects.toThrow("invalid_id_token");
    await expect(verify(await sign({ nonce: undefined }))).rejects.toThrow("invalid_id_token");
  });
  it("rejects alg=none / unsigned tokens", async () => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b({ alg: "none" })}.${b({ sub: "x", iss: ISS, aud: AUD, nonce: NONCE, exp: 9999999999 })}.`;
    await expect(verify(unsigned)).rejects.toThrow("invalid_id_token");
  });
});

describe("discovery + pkce", () => {
  it("rejects issuer mismatch", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ issuer: "https://evil.test" }), { status: 200 })) as typeof fetch;
    await expect(discoverOidc(ISS, f)).rejects.toThrow("issuer_mismatch");
  });
  it("generatePkce challenge = S256(verifier)", () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
  it("exchangeCode sends code_verifier", async () => {
    let sent = "";
    const f = (async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
    }) as typeof fetch;
    await exchangeCode({
      tokenEndpoint: `${ISS}/token`, clientId: AUD, clientSecret: "s",
      code: "c", redirectUri: "http://x/cb", codeVerifier: "ver123", fetchImpl: f,
    });
    expect(new URLSearchParams(sent).get("code_verifier")).toBe("ver123");
  });
});
